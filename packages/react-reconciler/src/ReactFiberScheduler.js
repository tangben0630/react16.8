

import type {Fiber} from './ReactFiber';
import type {Batch, FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {Interaction} from 'scheduler/src/Tracing';

import {__interactionsRef, __subscriberRef} from 'scheduler/tracing';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  NoEffect,
  PerformedWork,
  Placement,
  Update,
  Snapshot,
  PlacementAndUpdate,
  Deletion,
  ContentReset,
  Callback,
  DidCapture,
  Ref,
  Incomplete,
  HostEffectMask,
} from 'shared/ReactSideEffectTags';
import {
  HostRoot,
  ClassComponent,
  HostComponent,
  ContextProvider,
  HostPortal,
} from 'shared/ReactWorkTags';
import {
  enableSchedulerTracing,
  enableProfilerTimer,
  enableUserTimingAPI,
  replayFailedUnitOfWorkWithInvokeGuardedCallback,
  warnAboutDeprecatedLifecycles,
} from 'shared/ReactFeatureFlags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

import {
  scheduleTimeout,
  cancelTimeout,
  noTimeout,
} from './ReactFiberHostConfig';

import ReactFiberInstrumentation from './ReactFiberInstrumentation';
import * as ReactCurrentFiber from './ReactCurrentFiber';
import {
  now,
  scheduleDeferredCallback,
  cancelDeferredCallback,
  prepareForCommit,
  resetAfterCommit,
} from './ReactFiberHostConfig';
import {
  markPendingPriorityLevel,
  markCommittedPriorityLevels,
  markSuspendedPriorityLevel,
  markPingedPriorityLevel,
  hasLowerPriorityWork,
  isPriorityLevelSuspended,
  findEarliestOutstandingPriorityLevel,
  didExpireAtExpirationTime,
} from './ReactFiberPendingPriority';
import {
  recordEffect,
  recordScheduleUpdate,
  startRequestCallbackTimer,
  stopRequestCallbackTimer,
  startWorkTimer,
  stopWorkTimer,
  stopFailedWorkTimer,
  startWorkLoopTimer,
  stopWorkLoopTimer,
  startCommitTimer,
  stopCommitTimer,
  startCommitSnapshotEffectsTimer,
  stopCommitSnapshotEffectsTimer,
  startCommitHostEffectsTimer,
  stopCommitHostEffectsTimer,
  startCommitLifeCyclesTimer,
  stopCommitLifeCyclesTimer,
} from './ReactDebugFiberPerf';
import {createWorkInProgress, assignFiberPropertiesInDEV} from './ReactFiber';
import {onCommitRoot} from './ReactFiberDevToolsHook';
import {
  NoWork,
  Sync,
  Never,
  msToExpirationTime,
  expirationTimeToMs,
  computeAsyncExpiration,
  computeInteractiveExpiration,
} from './ReactFiberExpirationTime';
import {ConcurrentMode, ProfileMode, NoContext} from './ReactTypeOfMode';
import {
  enqueueUpdate,
  resetCurrentlyProcessingQueue,
  ForceUpdate,
  createUpdate,
} from './ReactUpdateQueue';
import {createCapturedValue} from './ReactCapturedValue';
import {
  isContextProvider as isLegacyContextProvider,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
  popContext as popLegacyContext,
} from './ReactFiberContext';
import {popProvider, resetContextDependences} from './ReactFiberNewContext';
import {popHostContext, popHostContainer} from './ReactFiberHostContext';
import {
  recordCommitTime,
  startProfilerTimer,
  stopProfilerTimerIfRunningAndRecordDelta,
} from './ReactProfilerTimer';
import {
  checkThatStackIsEmpty,
  resetStackAfterFatalErrorInDev,
} from './ReactFiberStack';
import {beginWork} from './ReactFiberBeginWork';
import {completeWork} from './ReactFiberCompleteWork';
import {
  throwException,
  unwindWork,
  unwindInterruptedWork,
  createRootErrorUpdate,
  createClassErrorUpdate,
} from './ReactFiberUnwindWork';
import {
  commitBeforeMutationLifeCycles,
  commitResetTextContent,
  commitPlacement,
  commitDeletion,
  commitWork,
  commitLifeCycles,
  commitAttachRef,
  commitDetachRef,
} from './ReactFiberCommitWork';
import {Dispatcher} from './ReactFiberDispatcher';

export type Deadline = {
  timeRemaining(): number,
  didTimeout: boolean,
};

export type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): mixed,
};

const {ReactCurrentOwner} = ReactSharedInternals;
let didWarnAboutStateTransition;
//在createBatch中调用，但是createBatch并没有被调用，目前看来是没什么作用
//
let didWarnSetStateChildContext;
//
let warnAboutUpdateOnUnmounted;
//
let warnAboutInvalidUpdates;
//

// Used to ensure computeUniqueAsyncExpiration is monotonically increasing.
let lastUniqueAsyncExpiration: number = 0;

// Represents the expiration time that incoming updates should use. (If this
// is NoWork, use the default strategy: async updates in async mode, sync
// updates in sync mode.)
let expirationContext: ExpirationTime = NoWork;

let isWorking: boolean = false;

// The next work in progress fiber that we're currently working on.
let nextUnitOfWork: Fiber | null = null;
let nextRoot: FiberRoot | null = null;
// The time at which we're currently rendering work.
let nextRenderExpirationTime: ExpirationTime = NoWork;
let nextLatestAbsoluteTimeoutMs: number = -1;
let nextRenderDidError: boolean = false;

// The next fiber with an effect that we're currently committing.
let nextEffect: Fiber | null = null;

let isCommitting: boolean = false;

let legacyErrorBoundariesThatAlreadyFailed: Set<mixed> | null = null;

// Used for performance tracking.
let interruptedBy: Fiber | null = null;

let stashedWorkInProgressProperties;
let replayUnitOfWork;
let isReplayingFailedUnitOfWork;
let originalReplayError;
let rethrowOriginalError;

function resetStack() {
  //nextUnitOfWork 是用来记录遍历整个子树的时候, 执行到了哪个节点的更新
  //nextUnitOfWork !== null 代表之前更新的是一个异步的任务, 并且执行到一般由于时间片不够, 交还给浏览器,
  //然后这个值 记录的是下一个要执行的节点, 如果现在没有任务进来,没有优先级更高的任务进来打断, 等浏览器有空
  //react会回来继续执行 nextUnitOfWork
  //然后向上找被打断的任务
  if (nextUnitOfWork !== null) {
    //先判断执行到哪个节点的时候,下一个即将要更新的节点
    //如果浏览器有时间,会回来继续执行这个work
    let interruptedWork = nextUnitOfWork.return;
    while (interruptedWork !== null) {
      //向上寻找所有被打断的任务 work
      //unwindInterruptedWork ===>> 退回更新
      unwindInterruptedWork(interruptedWork);
      //unwindInterruptedWork  有更高优先级的任务进来需要更新, 
      //就是说, 之前更新了, 但是当前的更新任务是被延迟的, 现在想要更新, 也需要把之前更新过的状态恢复到以前
      interruptedWork = interruptedWork.return;
    }
  }

  nextRoot = null;
  nextRenderExpirationTime = NoWork;
  nextLatestAbsoluteTimeoutMs = -1;
  nextRenderDidError = false;
  nextUnitOfWork = null;
}

function commitAllHostEffects() {
  while (nextEffect !== null) {
    recordEffect();

    const effectTag = nextEffect.effectTag;

    if (effectTag & ContentReset) {
      commitResetTextContent(nextEffect);
    }

    if (effectTag & Ref) {
      const current = nextEffect.alternate;
      if (current !== null) {
        commitDetachRef(current);
      }
    }

    // The following switch statement is only concerned about placement,
    // updates, and deletions. To avoid needing to add a case for every
    // possible bitmap value, we remove the secondary effects from the
    // effect tag and switch on that value.
    let primaryEffectTag = effectTag & (Placement | Update | Deletion);
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        // TODO: findDOMNode doesn't rely on this any more but isMounted
        // does and isMounted is deprecated anyway so we should be able
        // to kill this.
        nextEffect.effectTag &= ~Placement;
        break;
      }
      case PlacementAndUpdate: {
        // Placement
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        nextEffect.effectTag &= ~Placement;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Update: {
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Deletion: {
        commitDeletion(nextEffect);
        break;
      }
    }
    nextEffect = nextEffect.nextEffect;
  }

}

function commitBeforeMutationLifecycles() {
  while (nextEffect !== null) {
    const effectTag = nextEffect.effectTag;
    if (effectTag & Snapshot) {
      recordEffect();
      const current = nextEffect.alternate;
      commitBeforeMutationLifeCycles(current, nextEffect);
    }

    // Don't cleanup effects yet;
    // This will be done by commitAllLifeCycles()
    nextEffect = nextEffect.nextEffect;
  }

}

function commitAllLifeCycles(
  finishedRoot: FiberRoot,
  committedExpirationTime: ExpirationTime,
) {
  while (nextEffect !== null) {
    const effectTag = nextEffect.effectTag;

    if (effectTag & (Update | Callback)) {
      recordEffect();
      const current = nextEffect.alternate;
      commitLifeCycles(
        finishedRoot,
        current,
        nextEffect,
        committedExpirationTime,
      );
    }

    if (effectTag & Ref) {
      recordEffect();
      commitAttachRef(nextEffect);
    }

    const next = nextEffect.nextEffect;
    // Ensure that we clean these up so that we don't accidentally keep them.
    // I'm not actually sure this matters because we can't reset firstEffect
    // and lastEffect since they're on every node, not just the effectful
    // ones. So we have to clean everything as we reuse nodes anyway.
    nextEffect.nextEffect = null;
    // Ensure that we reset the effectTag here so that we can rely on effect
    // tags to reason about the current life-cycle.
    nextEffect = next;
  }
}

function isAlreadyFailedLegacyErrorBoundary(instance: mixed): boolean {
  return (
    legacyErrorBoundariesThatAlreadyFailed !== null &&
    legacyErrorBoundariesThatAlreadyFailed.has(instance)
  );
}

function markLegacyErrorBoundaryAsFailed(instance: mixed) {
  if (legacyErrorBoundariesThatAlreadyFailed === null) {
    legacyErrorBoundariesThatAlreadyFailed = new Set([instance]);
  } else {
    legacyErrorBoundariesThatAlreadyFailed.add(instance);
  }
}

function commitRoot(root: FiberRoot, finishedWork: Fiber): void {
  isWorking = true;
  isCommitting = true;
  startCommitTimer();

  invariant(
    root.current !== finishedWork,
    'Cannot commit the same tree as before. This is probably a bug ' +
      'related to the return field. This error is likely caused by a bug ' +
      'in React. Please file an issue.',
  );
  const committedExpirationTime = root.pendingCommitExpirationTime;
  invariant(
    committedExpirationTime !== NoWork,
    'Cannot commit an incomplete root. This error is likely caused by a ' +
      'bug in React. Please file an issue.',
  );
  root.pendingCommitExpirationTime = NoWork;

  // Update the pending priority levels to account for the work that we are
  // about to commit. This needs to happen before calling the lifecycles, since
  // they may schedule additional updates.
  const updateExpirationTimeBeforeCommit = finishedWork.expirationTime;
  const childExpirationTimeBeforeCommit = finishedWork.childExpirationTime;
  const earliestRemainingTimeBeforeCommit =
    updateExpirationTimeBeforeCommit === NoWork ||
    (childExpirationTimeBeforeCommit !== NoWork &&
      childExpirationTimeBeforeCommit < updateExpirationTimeBeforeCommit)
      ? childExpirationTimeBeforeCommit
      : updateExpirationTimeBeforeCommit;
  markCommittedPriorityLevels(root, earliestRemainingTimeBeforeCommit);

  let prevInteractions: Set<Interaction> = (null: any);
  if (enableSchedulerTracing) {
    // Restore any pending interactions at this point,
    // So that cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  // Reset this to null before calling lifecycles
  ReactCurrentOwner.current = null;

  let firstEffect;
  if (finishedWork.effectTag > PerformedWork) {
    // A fiber's effect list consists only of its children, not itself. So if
    // the root has an effect, we need to add it to the end of the list. The
    // resulting list is the set that would belong to the root's parent, if
    // it had one; that is, all the effects in the tree including the root.
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork;
      firstEffect = finishedWork.firstEffect;
    } else {
      firstEffect = finishedWork;
    }
  } else {
    // There is no effect on the root.
    firstEffect = finishedWork.firstEffect;
  }

  prepareForCommit(root.containerInfo);

  // Invoke instances of getSnapshotBeforeUpdate before mutation.
  nextEffect = firstEffect;
  startCommitSnapshotEffectsTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
    } else {
      try {
        commitBeforeMutationLifecycles();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitSnapshotEffectsTimer();

  if (enableProfilerTimer) {
    // Mark the current commit time to be shared by all Profilers in this batch.
    // This enables them to be grouped later.
    recordCommitTime();
  }

  // Commit all the side-effects within a tree. We'll do this in two passes.
  // The first pass performs all the host insertions, updates, deletions and
  // ref unmounts.
  nextEffect = firstEffect;
  startCommitHostEffectsTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
    } else {
      try {
        commitAllHostEffects();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitHostEffectsTimer();

  resetAfterCommit(root.containerInfo);

  // The work-in-progress tree is now the current tree. This must come after
  // the first pass of the commit phase, so that the previous tree is still
  // current during componentWillUnmount, but before the second pass, so that
  // the finished work is current during componentDidMount/Update.
  root.current = finishedWork;

  nextEffect = firstEffect;
  startCommitLifeCyclesTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
    } else {
      try {
        commitAllLifeCycles(root, committedExpirationTime);
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }

  isCommitting = false;
  isWorking = false;
  stopCommitLifeCyclesTimer();
  stopCommitTimer();
  onCommitRoot(finishedWork.stateNode);
  const updateExpirationTimeAfterCommit = finishedWork.expirationTime;
  const childExpirationTimeAfterCommit = finishedWork.childExpirationTime;
  const earliestRemainingTimeAfterCommit =
    updateExpirationTimeAfterCommit === NoWork ||
    (childExpirationTimeAfterCommit !== NoWork &&
      childExpirationTimeAfterCommit < updateExpirationTimeAfterCommit)
      ? childExpirationTimeAfterCommit
      : updateExpirationTimeAfterCommit;
  if (earliestRemainingTimeAfterCommit === NoWork) {
    // If there's no remaining work, we can clear the set of already failed
    // error boundaries.
    legacyErrorBoundariesThatAlreadyFailed = null;
  }
  onCommit(root, earliestRemainingTimeAfterCommit);

  if (enableSchedulerTracing) {
    __interactionsRef.current = prevInteractions;

    let subscriber;

    try {
      subscriber = __subscriberRef.current;
      if (subscriber !== null && root.memoizedInteractions.size > 0) {
        const threadID = computeThreadID(
          committedExpirationTime,
          root.interactionThreadID,
        );
        subscriber.onWorkStopped(root.memoizedInteractions, threadID);
      }
    } catch (error) {
      // It's not safe for commitRoot() to throw.
      // Store the error for now and we'll re-throw in finishRendering().
      if (!hasUnhandledError) {
        hasUnhandledError = true;
        unhandledError = error;
      }
    } finally {
      // Clear completed interactions from the pending Map.
      // Unless the render was suspended or cascading work was scheduled,
      // In which case– leave pending interactions until the subsequent render.
      const pendingInteractionMap = root.pendingInteractionMap;
      pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          // Only decrement the pending interaction count if we're done.
          // If there's still work at the current priority,
          // That indicates that we are waiting for suspense data.
          if (
            earliestRemainingTimeAfterCommit === NoWork ||
            scheduledExpirationTime < earliestRemainingTimeAfterCommit
          ) {
            pendingInteractionMap.delete(scheduledExpirationTime);

            scheduledInteractions.forEach(interaction => {
              interaction.__count--;

              if (subscriber !== null && interaction.__count === 0) {
                try {
                  subscriber.onInteractionScheduledWorkCompleted(interaction);
                } catch (error) {
                  // It's not safe for commitRoot() to throw.
                  // Store the error for now and we'll re-throw in finishRendering().
                  if (!hasUnhandledError) {
                    hasUnhandledError = true;
                    unhandledError = error;
                  }
                }
              }
            });
          }
        },
      );
    }
  }
}

function resetChildExpirationTime(
  workInProgress: Fiber,
  renderTime: ExpirationTime,
) {
  if (renderTime !== Never && workInProgress.childExpirationTime === Never) {
    // The children of this component are hidden. Don't bubble their
    // expiration times.
    return;
  }

  let newChildExpirationTime = NoWork;

  // Bubble up the earliest expiration time.
  if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
    // We're in profiling mode.
    // Let's use this same traversal to update the render durations.
    let actualDuration = workInProgress.actualDuration;
    let treeBaseDuration = workInProgress.selfBaseDuration;

    // When a fiber is cloned, its actualDuration is reset to 0.
    // This value will only be updated if work is done on the fiber (i.e. it doesn't bailout).
    // When work is done, it should bubble to the parent's actualDuration.
    // If the fiber has not been cloned though, (meaning no work was done),
    // Then this value will reflect the amount of time spent working on a previous render.
    // In that case it should not bubble.
    // We determine whether it was cloned by comparing the child pointer.
    const shouldBubbleActualDurations =
      workInProgress.alternate === null ||
      workInProgress.child !== workInProgress.alternate.child;

    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (
        newChildExpirationTime === NoWork ||
        (childUpdateExpirationTime !== NoWork &&
          childUpdateExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (
        newChildExpirationTime === NoWork ||
        (childChildExpirationTime !== NoWork &&
          childChildExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childChildExpirationTime;
      }
      if (shouldBubbleActualDurations) {
        actualDuration += child.actualDuration;
      }
      treeBaseDuration += child.treeBaseDuration;
      child = child.sibling;
    }
    workInProgress.actualDuration = actualDuration;
    workInProgress.treeBaseDuration = treeBaseDuration;
  } else {
    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (
        newChildExpirationTime === NoWork ||
        (childUpdateExpirationTime !== NoWork &&
          childUpdateExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (
        newChildExpirationTime === NoWork ||
        (childChildExpirationTime !== NoWork &&
          childChildExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childChildExpirationTime;
      }
      child = child.sibling;
    }
  }

  workInProgress.childExpirationTime = newChildExpirationTime;
}

function completeUnitOfWork(workInProgress: Fiber): Fiber | null {
  // Attempt to complete the current unit of work, then move to the
  // next sibling. If there are no more siblings, return to the
  // parent fiber.
  while (true) {
    // The current, flushed, state of this fiber is the alternate.
    // Ideally nothing should rely on this, but relying on it here
    // means that we don't need an additional field on the work in
    // progress.
    const current = workInProgress.alternate;
    const returnFiber = workInProgress.return;
    const siblingFiber = workInProgress.sibling;

    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      // This fiber completed.
      if (enableProfilerTimer) {
        if (workInProgress.mode & ProfileMode) {
          startProfilerTimer(workInProgress);
        }

        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );

        if (workInProgress.mode & ProfileMode) {
          // Update render duration assuming we didn't error.
          stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
        }
      } else {
        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );
      }
      stopWorkTimer(workInProgress);
      resetChildExpirationTime(workInProgress, nextRenderExpirationTime);

      if (
        returnFiber !== null &&
        // Do not append effects to parents if a sibling failed to complete
        (returnFiber.effectTag & Incomplete) === NoEffect
      ) {
        // Append all the effects of the subtree and this fiber onto the effect
        // list of the parent. The completion order of the children affects the
        // side-effect order.
        if (returnFiber.firstEffect === null) {
          returnFiber.firstEffect = workInProgress.firstEffect;
        }
        if (workInProgress.lastEffect !== null) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect;
          }
          returnFiber.lastEffect = workInProgress.lastEffect;
        }

        // If this fiber had side-effects, we append it AFTER the children's
        // side-effects. We can perform certain side-effects earlier if
        // needed, by doing multiple passes over the effect list. We don't want
        // to schedule our own side-effect on our own list because if end up
        // reusing children we'll schedule this effect onto itself since we're
        // at the end.
        const effectTag = workInProgress.effectTag;
        // Skip both NoWork and PerformedWork tags when creating the effect list.
        // PerformedWork effect is read by React DevTools but shouldn't be committed.
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress;
          } else {
            returnFiber.firstEffect = workInProgress;
          }
          returnFiber.lastEffect = workInProgress;
        }
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        workInProgress = returnFiber;
        continue;
      } else {
        // We've reached the root.
        return null;
      }
    } else {
      if (workInProgress.mode & ProfileMode) {
        // Record the render duration for the fiber that errored.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
      }

      // This fiber did not complete because something threw. Pop values off
      // the stack without entering the complete phase. If this is a boundary,
      // capture values if possible.
      const next = unwindWork(workInProgress, nextRenderExpirationTime);
      // Because this fiber did not complete, don't reset its expiration time.
      if (workInProgress.effectTag & DidCapture) {
        // Restarting an error boundary
        stopFailedWorkTimer(workInProgress);
      } else {
        stopWorkTimer(workInProgress);
      }

      if (next !== null) {
        stopWorkTimer(workInProgress);
        if (enableProfilerTimer) {
          // Include the time spent working on failed children before continuing.
          if (next.mode & ProfileMode) {
            let actualDuration = next.actualDuration;
            let child = next.child;
            while (child !== null) {
              actualDuration += child.actualDuration;
              child = child.sibling;
            }
            next.actualDuration = actualDuration;
          }
        }

        // If completing this work spawned new work, do that next. We'll come
        // back here again.
        // Since we're restarting, remove anything that is not a host effect
        // from the effect tag.
        next.effectTag &= HostEffectMask;
        return next;
      }

      if (returnFiber !== null) {
        // Mark the parent fiber as incomplete and clear its effect list.
        returnFiber.firstEffect = returnFiber.lastEffect = null;
        returnFiber.effectTag |= Incomplete;
      }
      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        workInProgress = returnFiber;
        continue;
      } else {
        return null;
      }
    }
  }

  // Without this explicit null return Flow complains of invalid return type
  // TODO Remove the above while(true) loop
  // eslint-disable-next-line no-unreachable
  return null;
}

function performUnitOfWork(workInProgress: Fiber): Fiber | null {
  // The current, flushed, state of this fiber is the alternate.
  // Ideally nothing should rely on this, but relying on it here
  // means that we don't need an additional field on the work in
  // progress.
  const current = workInProgress.alternate;

  // See if beginning this work spawns more work.
  startWorkTimer(workInProgress);

  let next;
  if (enableProfilerTimer) {
    if (workInProgress.mode & ProfileMode) {
      startProfilerTimer(workInProgress);
    }

    next = beginWork(current, workInProgress, nextRenderExpirationTime);
    workInProgress.memoizedProps = workInProgress.pendingProps;

    if (workInProgress.mode & ProfileMode) {
      // Record the render duration assuming we didn't bailout (or error).
      stopProfilerTimerIfRunningAndRecordDelta(workInProgress, true);
    }
  } else {
    next = beginWork(current, workInProgress, nextRenderExpirationTime);
    workInProgress.memoizedProps = workInProgress.pendingProps;
  }
  if (next === null) {
    // If this doesn't spawn new work, complete the current work.
    next = completeUnitOfWork(workInProgress);
  }

  ReactCurrentOwner.current = null;

  return next;
}

function workLoop(isYieldy) {
  if (!isYieldy) {
    // Flush work without yielding
    while (nextUnitOfWork !== null) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  } else {
    // Flush asynchronous work until the deadline runs out of time.
    while (nextUnitOfWork !== null && !shouldYield()) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  }
}

function renderRoot(
  root: FiberRoot,
  isYieldy: boolean,
  isExpired: boolean,
): void {
  invariant(
    !isWorking,
    'renderRoot was called recursively. This error is likely caused ' +
      'by a bug in React. Please file an issue.',
  );
  isWorking = true;
  ReactCurrentOwner.currentDispatcher = Dispatcher;

  const expirationTime = root.nextExpirationTimeToWorkOn;

  // Check if we're starting from a fresh stack, or if we're resuming from
  // previously yielded work.
  if (
    expirationTime !== nextRenderExpirationTime ||
    root !== nextRoot ||
    nextUnitOfWork === null
  ) {
    // Reset the stack and start working from the root.
    resetStack();
    nextRoot = root;
    nextRenderExpirationTime = expirationTime;
    // nextUnitOfWork 是一个 fiber 对象, 对应的是 RootFiber 而不是 FiberRoot
    nextUnitOfWork = createWorkInProgress(
      nextRoot.current,
      null,
      nextRenderExpirationTime,
    );
    root.pendingCommitExpirationTime = NoWork;

    if (enableSchedulerTracing) {
      // Determine which interactions this batch of work currently includes,
      // So that we can accurately attribute time spent working on it,
      // And so that cascading work triggered during the render phase will be associated with it.
      const interactions: Set<Interaction> = new Set();
      root.pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          if (scheduledExpirationTime <= expirationTime) {
            scheduledInteractions.forEach(interaction =>
              interactions.add(interaction),
            );
          }
        },
      );

      // Store the current set of interactions on the FiberRoot for a few reasons:
      // We can re-use it in hot functions like renderRoot() without having to recalculate it.
      // We will also use it in commitWork() to pass to any Profiler onRender() hooks.
      // This also provides DevTools with a way to access it when the onCommitRoot() hook is called.
      root.memoizedInteractions = interactions;

      if (interactions.size > 0) {
        const subscriber = __subscriberRef.current;
        if (subscriber !== null) {
          const threadID = computeThreadID(
            expirationTime,
            root.interactionThreadID,
          );
          try {
            subscriber.onWorkStarted(interactions, threadID);
          } catch (error) {
            // Work thrown by an interaction tracing subscriber should be rethrown,
            // But only once it's safe (to avoid leaveing the scheduler in an invalid state).
            // Store the error for now and we'll re-throw in finishRendering().
            if (!hasUnhandledError) {
              hasUnhandledError = true;
              unhandledError = error;
            }
          }
        }
      }
    }
  }

  let prevInteractions: Set<Interaction> = (null: any);
  if (enableSchedulerTracing) {
    // We're about to start new traced work.
    // Restore pending interactions so cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  let didFatal = false;

  startWorkLoopTimer(nextUnitOfWork);

  do {
    try {
      workLoop(isYieldy);
    } catch (thrownValue) {
      if (nextUnitOfWork === null) {
        // This is a fatal error.
        didFatal = true;
        onUncaughtError(thrownValue);
      } else {
        const failedUnitOfWork: Fiber = nextUnitOfWork;
        const sourceFiber: Fiber = nextUnitOfWork;
        let returnFiber = sourceFiber.return;
        if (returnFiber === null) {
          didFatal = true;
          onUncaughtError(thrownValue);
        } else {
          throwException(
            root,
            returnFiber,
            sourceFiber,
            thrownValue,
            nextRenderExpirationTime,
          );
          nextUnitOfWork = completeUnitOfWork(sourceFiber);
          continue;
        }
      }
    }
    break;
  } while (true);

  if (enableSchedulerTracing) {
    // Traced work is done for now; restore the previous interactions.
    __interactionsRef.current = prevInteractions;
  }

  // We're done performing work. Time to clean up.
  isWorking = false;
  ReactCurrentOwner.currentDispatcher = null;
  resetContextDependences();

  // Yield back to main thread.
  if (didFatal) {
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    nextRoot = null;
    onFatal(root);
    return;
  }

  if (nextUnitOfWork !== null) {
    // There's still remaining async work in this tree, but we ran out of time
    // in the current frame. Yield back to the renderer. Unless we're
    // interrupted by a higher priority update, we'll continue later from where
    // we left off.
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    onYield(root);
    return;
  }

  // We completed the whole tree.
  const didCompleteRoot = true;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  const rootWorkInProgress = root.current.alternate;
  invariant(
    rootWorkInProgress !== null,
    'Finished root should have a work-in-progress. This error is likely ' +
      'caused by a bug in React. Please file an issue.',
  );

  // `nextRoot` points to the in-progress root. A non-null value indicates
  // that we're in the middle of an async render. Set it to null to indicate
  // there's no more work to be done in the current batch.
  nextRoot = null;
  interruptedBy = null;

  if (nextRenderDidError) {
    // There was an error
    if (hasLowerPriorityWork(root, expirationTime)) {
      // There's lower priority work. If so, it may have the effect of fixing
      // the exception that was just thrown. Exit without committing. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve. React will restart at the lower
      // priority level.
      markSuspendedPriorityLevel(root, expirationTime);
      const suspendedExpirationTime = expirationTime;
      const rootExpirationTime = root.expirationTime;
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    } else if (
      // There's no lower priority work, but we're rendering asynchronously.
      // Synchronsouly attempt to render the same level one more time. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve.
      !root.didError &&
      !isExpired
    ) {
      root.didError = true;
      const suspendedExpirationTime = (root.nextExpirationTimeToWorkOn = expirationTime);
      const rootExpirationTime = (root.expirationTime = Sync);
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    }
  }

  if (!isExpired && nextLatestAbsoluteTimeoutMs !== -1) {
    // The tree was suspended.
    const suspendedExpirationTime = expirationTime;
    markSuspendedPriorityLevel(root, suspendedExpirationTime);

    // Find the earliest uncommitted expiration time in the tree, including
    // work that is suspended. The timeout threshold cannot be longer than
    // the overall expiration.
    const earliestExpirationTime = findEarliestOutstandingPriorityLevel(
      root,
      expirationTime,
    );
    const earliestExpirationTimeMs = expirationTimeToMs(earliestExpirationTime);
    if (earliestExpirationTimeMs < nextLatestAbsoluteTimeoutMs) {
      nextLatestAbsoluteTimeoutMs = earliestExpirationTimeMs;
    }

    // Subtract the current time from the absolute timeout to get the number
    // of milliseconds until the timeout. In other words, convert an absolute
    // timestamp to a relative time. This is the value that is passed
    // to `setTimeout`.
    const currentTimeMs = expirationTimeToMs(requestCurrentTime());
    let msUntilTimeout = nextLatestAbsoluteTimeoutMs - currentTimeMs;
    msUntilTimeout = msUntilTimeout < 0 ? 0 : msUntilTimeout;

    // TODO: Account for the Just Noticeable Difference

    const rootExpirationTime = root.expirationTime;
    onSuspend(
      root,
      rootWorkInProgress,
      suspendedExpirationTime,
      rootExpirationTime,
      msUntilTimeout,
    );
    return;
  }

  // Ready to commit.
  onComplete(root, rootWorkInProgress, expirationTime);
}

function dispatch(
  sourceFiber: Fiber,
  value: mixed,
  expirationTime: ExpirationTime,
) {
  invariant(
    !isWorking || isCommitting,
    'dispatch: Cannot dispatch during the render phase.',
  );

  let fiber = sourceFiber.return;
  while (fiber !== null) {
    switch (fiber.tag) {
      case ClassComponent:
        const ctor = fiber.type;
        const instance = fiber.stateNode;
        if (
          typeof ctor.getDerivedStateFromError === 'function' ||
          (typeof instance.componentDidCatch === 'function' &&
            !isAlreadyFailedLegacyErrorBoundary(instance))
        ) {
          const errorInfo = createCapturedValue(value, sourceFiber);
          const update = createClassErrorUpdate(
            fiber,
            errorInfo,
            expirationTime,
          );
          enqueueUpdate(fiber, update);
          scheduleWork(fiber, expirationTime);
          return;
        }
        break;
      case HostRoot: {
        const errorInfo = createCapturedValue(value, sourceFiber);
        const update = createRootErrorUpdate(fiber, errorInfo, expirationTime);
        enqueueUpdate(fiber, update);
        scheduleWork(fiber, expirationTime);
        return;
      }
    }
    fiber = fiber.return;
  }

  if (sourceFiber.tag === HostRoot) {
    // Error was thrown at the root. There is no parent, so the root
    // itself should capture it.
    const rootFiber = sourceFiber;
    const errorInfo = createCapturedValue(value, rootFiber);
    const update = createRootErrorUpdate(rootFiber, errorInfo, expirationTime);
    enqueueUpdate(rootFiber, update);
    scheduleWork(rootFiber, expirationTime);
  }
}

function captureCommitPhaseError(fiber: Fiber, error: mixed) {
  return dispatch(fiber, error, Sync);
}

function computeThreadID(
  expirationTime: ExpirationTime,
  interactionThreadID: number,
): number {
  // Interaction threads are unique per root and expiration time.
  return expirationTime * 1000 + interactionThreadID;
}

// Creates a unique async expiration time.
function computeUniqueAsyncExpiration(): ExpirationTime {
  const currentTime = requestCurrentTime();
  let result = computeAsyncExpiration(currentTime);
  if (result <= lastUniqueAsyncExpiration) {
    // Since we assume the current time monotonically increases, we only hit
    // this branch when computeUniqueAsyncExpiration is fired multiple times
    // within a 200ms window (or whatever the async bucket size is).
    result = lastUniqueAsyncExpiration + 1;
  }
  lastUniqueAsyncExpiration = result;
  return lastUniqueAsyncExpiration;
}

function computeExpirationForFiber(currentTime: ExpirationTime, fiber: Fiber) {
  let expirationTime;
  if (expirationContext !== NoWork) {
    // An explicit expiration context was set;
    expirationTime = expirationContext;
  } else if (isWorking) {
    if (isCommitting) {
      // Updates that occur during the commit phase should have sync priority
      // by default.
      expirationTime = Sync;
    } else {
      // Updates during the render phase should expire at the same time as
      // the work that is being rendered.
      expirationTime = nextRenderExpirationTime;
    }
  } else {
    // No explicit expiration context was set, and we're not currently
    // performing work. Calculate a new expiration time.
    if (fiber.mode & ConcurrentMode) {
      //这里的判断是 判断更新时同步还是异步的
      if (isBatchingInteractiveUpdates) {
        // This is an interactive update
        //判断调用哪种计算时间的方式
        expirationTime = computeInteractiveExpiration(currentTime);
      } else {
        // This is an async update
        expirationTime = computeAsyncExpiration(currentTime);
      }
      // If we're in the middle of rendering a tree, do not update at the same
      // expiration time that is already rendering.
      if (nextRoot !== null && expirationTime === nextRenderExpirationTime) {
        expirationTime += 1;
        //+1 的目的是为了区别当前正在进行的更新和下一个即将进行的更新 防止 expirationTime是一个相同的值
      }
    } else {
      // This is a sync update
      expirationTime = Sync;
    }
  }
  if (isBatchingInteractiveUpdates) {
    // This is an interactive update. Keep track of the lowest pending
    // interactive expiration time. This allows us to synchronously flush
    // all interactive updates when needed.
    if (expirationTime > lowestPriorityPendingInteractiveExpirationTime) {
      lowestPriorityPendingInteractiveExpirationTime = expirationTime;
    }
  }
  return expirationTime;
}

function renderDidSuspend(
  root: FiberRoot,
  absoluteTimeoutMs: number,
  suspendedTime: ExpirationTime,
) {
  // Schedule the timeout.
  if (
    absoluteTimeoutMs >= 0 &&
    nextLatestAbsoluteTimeoutMs < absoluteTimeoutMs
  ) {
    nextLatestAbsoluteTimeoutMs = absoluteTimeoutMs;
  }
}

function renderDidError() {
  nextRenderDidError = true;
}

function retrySuspendedRoot(
  root: FiberRoot,
  boundaryFiber: Fiber,
  sourceFiber: Fiber,
  suspendedTime: ExpirationTime,
) {
  let retryTime;

  if (isPriorityLevelSuspended(root, suspendedTime)) {
    // Ping at the original level
    retryTime = suspendedTime;

    markPingedPriorityLevel(root, retryTime);
  } else {
    // Suspense already timed out. Compute a new expiration time
    const currentTime = requestCurrentTime();
    retryTime = computeExpirationForFiber(currentTime, boundaryFiber);
    markPendingPriorityLevel(root, retryTime);
  }

  // TODO: If the suspense fiber has already rendered the primary children
  // without suspending (that is, all of the promises have already resolved),
  // we should not trigger another update here. One case this happens is when
  // we are in sync mode and a single promise is thrown both on initial render
  // and on update; we attach two .then(retrySuspendedRoot) callbacks and each
  // one performs Sync work, rerendering the Suspense.

  if ((boundaryFiber.mode & ConcurrentMode) !== NoContext) {
    if (root === nextRoot && nextRenderExpirationTime === suspendedTime) {
      // Received a ping at the same priority level at which we're currently
      // rendering. Restart from the root.
      nextRoot = null;
    }
  }

  scheduleWorkToRoot(boundaryFiber, retryTime);
  if ((boundaryFiber.mode & ConcurrentMode) === NoContext) {
    //记录更新流程中的时间的 scheduleWorkToRoot
    scheduleWorkToRoot(sourceFiber, retryTime);
    const sourceTag = sourceFiber.tag;
    if (sourceTag === ClassComponent && sourceFiber.stateNode !== null) {
      // When we try rendering again, we should not reuse the current fiber,
      // since it's known to be in an inconsistent state. Use a force updte to
      // prevent a bail out.
      const update = createUpdate(retryTime);
      update.tag = ForceUpdate;
      enqueueUpdate(sourceFiber, update);
    }
  }

  const rootExpirationTime = root.expirationTime;
  if (rootExpirationTime !== NoWork) {
    requestWork(root, rootExpirationTime);
  }
}
//scheduleWorkToRoot   根据传入进来的fiber节点,向上寻找所对应的RootFiber对象
//找的过程中也会进行一系列的操作
function scheduleWorkToRoot(fiber: Fiber, expirationTime): FiberRoot | null {
  //这个方法是用来记录更新的时间的,调取的是一个时间的记录
  //expirationTime  最新的update 产生的expirationTime
  recordScheduleUpdate();
  // Update the source fiber's expiration time   更新产生更新的fiber的expirationTime
  // expirationTime ===>> 对应这一次创建的更新的过期时间
  if (
    fiber.expirationTime === NoWork ||
    fiber.expirationTime > expirationTime
  ) {
    //fiber.expirationTime === NoWork 这个节点没有任何更新操作
    //更新完成之后,会把expirationTime去掉,
    //如果fiber.expirationTime > 当前更新的 expirationTime  会把当前设置为优先级更高的, 证明这个对象之前有更新
    //,并且更新没有完成, 更新原来的 expirationTime
    // 更新原来 fiber 的 expirationTime
    //最新产生的update的优先级, 是要低于当前fiber的优先级 
    fiber.expirationTime = expirationTime;
  }
  let alternate = fiber.alternate;
  if (
    alternate !== null &&
    (alternate.expirationTime === NoWork ||
      alternate.expirationTime > expirationTime)
  ) {
    alternate.expirationTime = expirationTime;
    //更新 alternate 的 expirationTime
  }
  // Walk the parent path to the root and update the child expiration time.
  let node = fiber.return; //返回的是当前node的父级
  let root = null;
  if (node === null && fiber.tag === HostRoot) {//找到了根节点
    root = fiber.stateNode;
    //stateNode 就是 FiberRoot 对象
  } else {
    while (node !== null) { //node === null    只有RootFiber.return才会是null, 其他都不是
      alternate = node.alternate;
      if (
        node.childExpirationTime === NoWork ||
        //寻找子节点中 优先级最高的额 ExpirationTime   childExpirationTime ==> 子树中优先级最高的 ExpirationTime
        node.childExpirationTime > expirationTime
      ) {
        //如果子树中优先级最高的 > 当前更新的 ExpirationTime 
        //就是在子节点中寻找优先级最高的,然后赋值了最新的 expirationTime
        //当前产生的更新, 在子节点中是不是优先级最高的
        node.childExpirationTime = expirationTime;
        if (
          alternate !== null &&
          (alternate.childExpirationTime === NoWork ||
            alternate.childExpirationTime > expirationTime)
        ) {
          alternate.childExpirationTime = expirationTime;
          //alternate 也需要进行单独的更新
        }
      } else if (
        alternate !== null &&
        (alternate.childExpirationTime === NoWork ||
          alternate.childExpirationTime > expirationTime)
      ) {
        alternate.childExpirationTime = expirationTime;
      }
      if (node.return === null && node.tag === HostRoot) {//这里表示 node是 RootFiber
        root = node.stateNode;
        //stateNode 就是 fiberroot 对象
        break;
      }
      node = node.return;
    }
  }

  if (root === null) {
    // 没有fiber 节点
    return null;
  }

  if (enableSchedulerTracing) {
    const interactions = __interactionsRef.current;
    if (interactions.size > 0) {
      const pendingInteractionMap = root.pendingInteractionMap;
      const pendingInteractions = pendingInteractionMap.get(expirationTime);
      if (pendingInteractions != null) {
        interactions.forEach(interaction => {
          if (!pendingInteractions.has(interaction)) {
            // Update the pending async work count for previously unscheduled interaction.
            interaction.__count++;
          }

          pendingInteractions.add(interaction);
        });
      } else {
        pendingInteractionMap.set(expirationTime, new Set(interactions));

        // Update the pending async work count for the current interactions.
        interactions.forEach(interaction => {
          interaction.__count++;
        });
      }

      const subscriber = __subscriberRef.current;
      if (subscriber !== null) {
        const threadID = computeThreadID(
          expirationTime,
          root.interactionThreadID,
        );
        subscriber.onWorkScheduled(interactions, threadID);
      }
    }
  }

  return root;
}

function scheduleWork(fiber: Fiber, expirationTime: ExpirationTime) {//开始调度工作
  //根据Fiber节点向上寻找对应的fiber对象, 
  const root = scheduleWorkToRoot(fiber, expirationTime);
  if (root === null) {
    return;
  }

  if (
    !isWorking &&
    nextRenderExpirationTime !== NoWork &&
    expirationTime < nextRenderExpirationTime
     // 这个分支表示高优先级任务打断低优先级任务
  // 这种情况发生于以下场景：有一个优先级较低的任务（必然是异步任务）没有执行完，
  // 执行权交给了浏览器，这个时候有一个新的高优先级任务进来了
  // 这时候需要去执行高优先级任务，所以需要打断低优先级任务
  ) {
    // isWorking 代表有任务正在进行, 可能被中断
    // nextRenderExpirationTime !== NoWork 代表人物可能是个异步的任务 执行到了一半
    // This is an interruption. (Used for performance tracking.)
    // expirationTime < nextRenderExpirationTime 代表新的任务的优先级高于目前正在做的任务
    interruptedBy = fiber; //记录被谁打断的
    //新的高优先级的任务 打断了 老的 低优先级的任务
    resetStack();
  }
  markPendingPriorityLevel(root, expirationTime);
  if (
    !isWorking ||//没有正在工作
    isCommitting || //正在提交, 不可打断的阶段
    // ...unless this is a different root than the one we're rendering.
    nextRoot !== root//上一次筛选出来就要更新的root
  ) {
    //如果没有正在工作,或者正在提交的
    const rootExpirationTime = root.expirationTime;
    //获取当前的过期时间
    requestWork(root, rootExpirationTime);
  }
  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    // Reset this back to zero so subsequent updates don't throw.
    nestedUpdateCount = 0;
    //防止循环
    invariant(
      false,
      'Maximum update depth exceeded. This can happen when a ' +
        'component repeatedly calls setState inside ' +
        'componentWillUpdate or componentDidUpdate. React limits ' +
        'the number of nested updates to prevent infinite loops.',
    );
  }
}

function deferredUpdates<A>(fn: () => A): A {
  const currentTime = requestCurrentTime();
  const previousExpirationContext = expirationContext;
  const previousIsBatchingInteractiveUpdates = isBatchingInteractiveUpdates;
  expirationContext = computeAsyncExpiration(currentTime);
  isBatchingInteractiveUpdates = false;
  try {
    return fn();
  } finally {
    expirationContext = previousExpirationContext;
    isBatchingInteractiveUpdates = previousIsBatchingInteractiveUpdates;
  }
}

function syncUpdates<A, B, C0, D, R>(
  fn: (A, B, C0, D) => R,
  a: A,
  b: B,
  c: C0,
  d: D,
): R {
  const previousExpirationContext = expirationContext;
  expirationContext = Sync;
  try {
    return fn(a, b, c, d);
  } finally {
    expirationContext = previousExpirationContext;
  }
}

// TODO: Everything below this is written as if it has been lifted to the
// renderers. I'll do this in a follow-up.

// Linked-list of roots
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

let callbackExpirationTime: ExpirationTime = NoWork;
let callbackID: *;
let isRendering: boolean = false;
let nextFlushedRoot: FiberRoot | null = null;
let nextFlushedExpirationTime: ExpirationTime = NoWork;
let lowestPriorityPendingInteractiveExpirationTime: ExpirationTime = NoWork;
let deadlineDidExpire: boolean = false;
let hasUnhandledError: boolean = false;
let unhandledError: mixed | null = null;
let deadline: Deadline | null = null;

let isBatchingUpdates: boolean = false;
let isUnbatchingUpdates: boolean = false;
let isBatchingInteractiveUpdates: boolean = false;

let completedBatches: Array<Batch> | null = null;

let originalStartTimeMs: number = now();//最初的开始时间
let currentRendererTime: ExpirationTime = msToExpirationTime(
  originalStartTimeMs,
);
let currentSchedulerTime: ExpirationTime = currentRendererTime;

// Use these to prevent an infinite loop of nested updates
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount: number = 0;
let lastCommittedRootDuringThisBatch: FiberRoot | null = null;

const timeHeuristicForUnitOfWork = 1;

function recomputeCurrentRendererTime() {
  //现在的值 - 初始的值
  // 现在的值 - 最初的开始时间  从js加载完成到现在的时间
  const currentTimeMs = now() - originalStartTimeMs;
  currentRendererTime = msToExpirationTime(currentTimeMs);
}

function scheduleCallbackWithExpirationTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
) {
  // callbackExpirationTime 之前是否有callback在执行
  // callbackExpirationTime 上一次调用的方法返回去申请了一个callback, 这个callback也有一个 expirationTime
  // callbackExpirationTime !== NoWork 代表已经有一个callback在执行了
  if (callbackExpirationTime !== NoWork) {
    // A callback is already scheduled. Check its expiration time (timeout).
    if (expirationTime > callbackExpirationTime) {
      //判断当前的 expirationTime 是不是比之前的大
      // Existing callback has sufficient timeout. Exit.
      return;
    } else {
      if (callbackID !== null) {
        // Existing callback has insufficient timeout. Cancel and schedule a
        // new one.
        cancelDeferredCallback(callbackID);
      }
    }
    // The request callback timer is already running. Don't start a new one.
  } else {
    startRequestCallbackTimer();
  }

  callbackExpirationTime = expirationTime;
  //originalStartTimeMs ===>> react代码加载进来立马获取的一个时间
  const currentMs = now() - originalStartTimeMs; //从刚进js到现在的时间
  // 当前 performance.now() 和程序刚执行时的 performance.now() 相减
  // 转化成 ms
  const expirationTimeMs = expirationTimeToMs(expirationTime);//算出将来的时间
  // 当前任务的延迟过期时间，由过期时间 - 当前任务创建时间得出，超过时代表任务过期需要强制更新
  const timeout = expirationTimeMs - currentMs;//多长时间过期
  callbackID = scheduleDeferredCallback(performAsyncWork, {timeout});
   // 生成一个 callbackID，用于关闭任务
}

// For every call to renderRoot, one of onFatal, onComplete, onSuspend, and
// onYield is called upon exiting. We use these in lieu of returning a tuple.
// I've also chosen not to inline them into renderRoot because these will
// eventually be lifted into the renderer.
function onFatal(root) {
  root.finishedWork = null;
}

function onComplete(
  root: FiberRoot,
  finishedWork: Fiber,
  expirationTime: ExpirationTime,
) {
  root.pendingCommitExpirationTime = expirationTime;
  root.finishedWork = finishedWork;
}

function onSuspend(
  root: FiberRoot,
  finishedWork: Fiber,
  suspendedExpirationTime: ExpirationTime,
  rootExpirationTime: ExpirationTime,
  msUntilTimeout: number,
): void {
  root.expirationTime = rootExpirationTime;
  if (msUntilTimeout === 0 && !shouldYield()) {
    // Don't wait an additional tick. Commit the tree immediately.
    root.pendingCommitExpirationTime = suspendedExpirationTime;
    root.finishedWork = finishedWork;
  } else if (msUntilTimeout > 0) {
    // Wait `msUntilTimeout` milliseconds before committing.
    root.timeoutHandle = scheduleTimeout(
      onTimeout.bind(null, root, finishedWork, suspendedExpirationTime),
      msUntilTimeout,
    );
  }
}

function onYield(root) {
  root.finishedWork = null;
}

function onTimeout(root, finishedWork, suspendedExpirationTime) {
  // The root timed out. Commit it.
  root.pendingCommitExpirationTime = suspendedExpirationTime;
  root.finishedWork = finishedWork;
  // Read the current time before entering the commit phase. We can be
  // certain this won't cause tearing related to batching of event updates
  // because we're at the top of a timer event.
  recomputeCurrentRendererTime();
  currentSchedulerTime = currentRendererTime;
  flushRoot(root, suspendedExpirationTime);
}

function onCommit(root, expirationTime) {
  root.expirationTime = expirationTime;
  root.finishedWork = null;
}

function requestCurrentTime() {
  

  if (isRendering) {// We're already rendering.
    // We're already rendering. Return the most recently read time.
    // 已经进入到渲染阶段了
    return currentSchedulerTime;
  }
  // Check if there's pending work.
  findHighestPriorityRoot();
  if (
    nextFlushedExpirationTime === NoWork ||
    nextFlushedExpirationTime === Never
  ) {
    //初次的时候  这个条件是成立的 
    // If there's no pending work, or if the pending work is offscreen, we can
    // read the current time without risk of tearing.
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;
    return currentSchedulerTime;
  }
  // There's already pending work. We might be in the middle of a browser
  // event. If we were to read the current time, it could cause multiple updates
  // within the same event to receive different expiration times, leading to
  // tearing. Return the last read time. During the next idle callback, the
  // time will be updated.
  return currentSchedulerTime;
}

// requestWork is called by the scheduler whenever a root receives an update.
// It's up to the renderer to call renderRoot at some point in the future.
function requestWork(root: FiberRoot, expirationTime: ExpirationTime) {
  //expirationTime 用来记录调度的过期时间
  addRootToSchedule(root, expirationTime);
  if (isRendering) {
    // Prevent reentrancy. Remaining work will be scheduled at the end of
    // the currently rendering batch.
    return;
  }

  // 判断是否需要批量更新
  // 当我们触发事件回调时，其实回调会被 batchedUpdates 函数封装一次
  // 这个函数会把 isBatchingUpdates 设为 true，也就是说我们在事件回调函数内部
  // 调用 setState 不会马上触发 state 的更新及渲染，只是单纯创建了一个 updater，然后在这个分支 return 了
  // 只有当整个事件回调函数执行完毕后恢复 isBatchingUpdates 的值，并且执行 performSyncWork
  // 想必很多人知道在类似 setTimeout 中使用 setState 以后 state 会马上更新，如果你想在定时器回调中也实现批量更新，
  // 就可以使用 batchedUpdates 将你需要的代码封装一下
  if (isBatchingUpdates) {//批量处理相关
    // Flush work at the end of the batch.
    if (isUnbatchingUpdates) {
      // ...unless we're inside unbatchedUpdates, in which case we should
      // flush it now.
      nextFlushedRoot = root;
      nextFlushedExpirationTime = Sync;
      performWorkOnRoot(root, Sync, true);
    }
    return;
  }

  // TODO: Get rid of Sync and use current time?
  if (expirationTime === Sync) {
    performSyncWork();//调用同步代码
  } else {
    //不是同步的话，进行异步 调度
     // 函数核心是实现了 requestIdleCallback 的 polyfill 版本
    // 因为这个函数浏览器的兼容性很差
    // 具体作用可以查看 MDN 文档 https://developer.mozilla.org/zh-CN/docs/Web/API/Window/requestIdleCallback
    // 这个函数可以让浏览器空闲时期依次调用函数，这就可以让开发者在主事件循环中执行后台或低优先级的任务，
    // 而且不会对像动画和用户交互这样延迟敏感的事件产生影响
    scheduleCallbackWithExpirationTime(root, expirationTime);
  }
}

function addRootToSchedule(root: FiberRoot, expirationTime: ExpirationTime) {
  // Add the root to the schedule.
  // Check if this root is already part of the schedule.
  //主要操控两个全局变量 
  // 判断 root 是否调度过
  if (root.nextScheduledRoot === null) {
    //这是当前没有进行过调度 lastScheduledRoot firstScheduledRoot
    //形成单向链表的数据结构
    // This root is not already scheduled. Add it.
    root.expirationTime = expirationTime;
    //lastScheduledRoot 单向链表的结构  用来存储 root  全局变量
    if (lastScheduledRoot === null) {//是否有任务正在调度
      firstScheduledRoot = lastScheduledRoot = root;
      root.nextScheduledRoot = root;
      //如果只有一个root   root.nextScheduledRoot = root 等于自己

    } else {
      lastScheduledRoot.nextScheduledRoot = root;
      lastScheduledRoot = root;
      //把当前插入 单向链表的最后一个
      lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
    }
  } else {
    //当前已经进行过调度了
    // This root is already scheduled, but its priority may have increased.
    const remainingExpirationTime = root.expirationTime;
    if (
      remainingExpirationTime === NoWork ||
      expirationTime < remainingExpirationTime
    ) {
      // Update the priority.
      //把root.expirationTime 设置成为优先级最高的那个
      root.expirationTime = expirationTime;
    }
  }
}

function findHighestPriorityRoot() {
  let highestPriorityWork = NoWork;
  let highestPriorityRoot = null;
  if (lastScheduledRoot !== null) {
    //lastScheduledRoot == null 证明链表已经到头了
    let previousScheduledRoot = lastScheduledRoot;
    let root = firstScheduledRoot;
    while (root !== null) {
      const remainingExpirationTime = root.expirationTime;
      if (remainingExpirationTime === NoWork) {
        // This root no longer has work. Remove it from the scheduler.

        // TODO: This check is redudant, but Flow is confused by the branch
        // below where we set lastScheduledRoot to null, even though we break
        // from the loop right after.
        invariant(
          previousScheduledRoot !== null && lastScheduledRoot !== null,
          'Should have a previous and last root. This error is likely ' +
            'caused by a bug in React. Please file an issue.',
        );
        if (root === root.nextScheduledRoot) {
          // root 上面
          // This is the only root in the list.
          root.nextScheduledRoot = null;
          firstScheduledRoot = lastScheduledRoot = null;
          break;
        } else if (root === firstScheduledRoot) {
          // This is the first root in the list.
          const next = root.nextScheduledRoot;
          //获取当前的next
          firstScheduledRoot = next;
          //把当前表头 赋值为 下一个的root        
          lastScheduledRoot.nextScheduledRoot = next;
          //最后一个 root 的下一个 赋值为当前的 root  为什么? 目前不知道
          root.nextScheduledRoot = null;
          //之前的被删除了  目前 root.nextScheduledRoot 这个指针不需要了

        } else if (root === lastScheduledRoot) {
          // This is the last root in the list.
          lastScheduledRoot = previousScheduledRoot;
          lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
          root.nextScheduledRoot = null;
          break;
        } else {
          //单向链表中  把一个节点移除的操作
          previousScheduledRoot.nextScheduledRoot = root.nextScheduledRoot;
          root.nextScheduledRoot = null;
        }
        root = previousScheduledRoot.nextScheduledRoot;
      } else {
        if (
          highestPriorityWork === NoWork ||
          remainingExpirationTime < highestPriorityWork
        ) {
          // Update the priority, if it's higher
          highestPriorityWork = remainingExpirationTime;
          highestPriorityRoot = root;
        }
        if (root === lastScheduledRoot) {
          break;
        }
        if (highestPriorityWork === Sync) {
          // Sync is highest priority by definition so
          // we can stop searching.
          break;
        }
        previousScheduledRoot = root;
        root = root.nextScheduledRoot;
      }
    }
  }

  nextFlushedRoot = highestPriorityRoot;
  nextFlushedExpirationTime = highestPriorityWork;
}

function performAsyncWork(dl) {
  //3, 调用的是performAsyncWork , react会传给他一个 deadline , 遍历每个单元 更新
  //   通过deadline判断,当前任务是否还有js运行时间片(默认22ms), 如果超时 
  if (dl.didTimeout) {
    // 先判断帧到期时间和超时时间是否小于当前时间， 如果是的话， 则置didTimeout为true
    // didTimeout为什么true 证明还没过期
    // The callback timed out. That means at least one update has expired.
    // Iterate through the root schedule. If they contain expired work, set
    // the next render expiration time to the current time. This has the effect
    // of flushing all expired work in a single batch, instead of flushing each
    // level one at a time.
    if (firstScheduledRoot !== null) {
      recomputeCurrentRendererTime();
      let root: FiberRoot = firstScheduledRoot;
      do {
        didExpireAtExpirationTime(root, currentRendererTime);
        //标记在root节点上的变量 didExpireAtExpirationTime
        // The root schedule is circular, so this is never null.
        root = (root.nextScheduledRoot: any);
      } while (root !== firstScheduledRoot);
    }
  }
  //NoWork 没有任务的情况  -1
  performWork(NoWork, dl);
}

function performSyncWork() {
  performWork(Sync, null);
}

function performWork(minExpirationTime: ExpirationTime, dl: Deadline | null) {
  deadline = dl;
  // deadline 一帧内是否有剩余的时间
  // Keep working on roots until there's no more work, or until we reach
  // the deadline.
  findHighestPriorityRoot();
  //findHighestPriorityRoot() 找到下一个有优先级任务

  if (deadline !== null) {
    //这个就是异步调用的时候 
    //首先重新计算一个 rendertime
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;

    if (enableUserTimingAPI) {
      const didExpire = nextFlushedExpirationTime < currentRendererTime;
      const timeout = expirationTimeToMs(nextFlushedExpirationTime);
      stopRequestCallbackTimer(didExpire, timeout);
    }

    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&
      (minExpirationTime === NoWork ||
        minExpirationTime >= nextFlushedExpirationTime) &&
      (!deadlineDidExpire || currentRendererTime >= nextFlushedExpirationTime)
      //!deadlineDidExpire || currentRendererTime >= nextFlushedExpirationTime
      //时间片还有时间 或者 任务已经过期, 需要被强制输出
      //便会执行 performWorkOnRoot
    ) {
      performWorkOnRoot(
        nextFlushedRoot,
        nextFlushedExpirationTime,
        currentRendererTime >= nextFlushedExpirationTime,
        //currentRendererTime >= nextFlushedExpirationTime
        //如果过期 true ,  没有过期 传入的是 false
      );
      findHighestPriorityRoot();
      recomputeCurrentRendererTime();
      currentSchedulerTime = currentRendererTime;
    }
  } else {
    //进入同步调度
    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&//目前没有任务要进行
      (minExpirationTime === NoWork ||
        minExpirationTime >= nextFlushedExpirationTime)//
        //只会执行同步任务的更新
    ) {
      performWorkOnRoot(nextFlushedRoot, nextFlushedExpirationTime, true);
      //对应的同步任务会被执行掉, 执行的过程中会把rootExpirationTime置空
      //findHighestPriorityRoot() 找到下一个有优先级任务
      findHighestPriorityRoot();
    }
  }

  // We're done flushing work. Either we ran out of time in this callback,
  // or there's no more work left with sufficient priority.

  // If we're inside a callback, set this to false since we just completed it.
  if (deadline !== null) {
    callbackExpirationTime = NoWork;
    callbackID = null;
  }
  // If there's work left over, schedule a new callback.
  if (nextFlushedExpirationTime !== NoWork) {
    scheduleCallbackWithExpirationTime(
      ((nextFlushedRoot: any): FiberRoot),
      nextFlushedExpirationTime,
    );
  }

  // Clean-up.
  deadline = null;
  deadlineDidExpire = false;

  finishRendering();
}

function flushRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  invariant(
    !isRendering,
    'work.commit(): Cannot commit while already rendering. This likely ' +
      'means you attempted to commit from inside a lifecycle method.',
  );
  // Perform work on root as if the given expiration time is the current time.
  // This has the effect of synchronously flushing all work up to and
  // including the given time.
  nextFlushedRoot = root;
  nextFlushedExpirationTime = expirationTime;
  performWorkOnRoot(root, expirationTime, true);
  // Flush any sync work that was scheduled by lifecycles
  performSyncWork();
}

function finishRendering() {
  nestedUpdateCount = 0;
  lastCommittedRootDuringThisBatch = null;

  if (completedBatches !== null) {
    const batches = completedBatches;
    completedBatches = null;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        batch._onComplete();
      } catch (error) {
        if (!hasUnhandledError) {
          hasUnhandledError = true;
          unhandledError = error;
        }
      }
    }
  }

  if (hasUnhandledError) {
    const error = unhandledError;
    unhandledError = null;
    hasUnhandledError = false;
    throw error;
  }
}

function performWorkOnRoot(
  root: FiberRoot,
  expirationTime: ExpirationTime,
  isExpired: boolean,//是否过期
) {
  invariant(
    !isRendering,
      'by a bug in React. Please file an issue.',
  );

  isRendering = true;

  // Check if this is async work or sync/expired work.
  if (deadline === null || isExpired) {
    // deadline === null 是同步的情况
    // 同步更新, 强制
    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      //如果有已经完成的任务 需要提交
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      const timeoutHandle = root.timeoutHandle;
      if (timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      const isYieldy = false;
      //isYieldy  这个任务是否可以中断
      renderRoot(root, isYieldy, isExpired);
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Commit it.
        completeRoot(root, finishedWork, expirationTime);
      }
    }
  } else {
    // Flush async work.
    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      const timeoutHandle = root.timeoutHandle;
      if (timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      const isYieldy = true;
      //isYieldy 这个任务是可以被中断的
      renderRoot(root, isYieldy, isExpired);
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Check the deadline one more time
        // before committing.
        if (!shouldYield()) {  
          // Still time left. Commit the root.
          completeRoot(root, finishedWork, expirationTime);
          //更新的fiber树 映射到 dom树上面
        } else {
          // There's no time left. Mark this root as complete. We'll come
          // back and commit it later.
          root.finishedWork = finishedWork;
        }
      }
    }
  }

  isRendering = false;
}

function completeRoot(
  root: FiberRoot,
  finishedWork: Fiber,
  expirationTime: ExpirationTime,
): void {
  // Check if there's a batch that matches this expiration time.
  const firstBatch = root.firstBatch;
  if (firstBatch !== null && firstBatch._expirationTime <= expirationTime) {
    if (completedBatches === null) {
      completedBatches = [firstBatch];
    } else {
      completedBatches.push(firstBatch);
    }
    if (firstBatch._defer) {
      // This root is blocked from committing by a batch. Unschedule it until
      // we receive another update.
      root.finishedWork = finishedWork;
      root.expirationTime = NoWork;
      return;
    }
  }

  // Commit the root.
  root.finishedWork = null;

  // Check if this is a nested update (a sync update scheduled during the
  // commit phase).
  if (root === lastCommittedRootDuringThisBatch) {
    // If the next root is the same as the previous root, this is a nested
    // update. To prevent an infinite loop, increment the nested update count.
    nestedUpdateCount++;
  } else {
    // Reset whenever we switch roots.
    lastCommittedRootDuringThisBatch = root;
    nestedUpdateCount = 0;
  }
  commitRoot(root, finishedWork);
}

// When working on async work, the reconciler asks the renderer if it should
// yield execution. For DOM, we implement this with requestIdleCallback.
function shouldYield() {
  if (deadlineDidExpire) {//是否超时
    return true;
  }
  if (
    deadline === null ||
    deadline.timeRemaining() > timeHeuristicForUnitOfWork
  ) {
    // Disregard deadline.didTimeout. Only expired work should be flushed
    // during a timeout. This path is only hit for non-expired work.
    return false;
  }
  deadlineDidExpire = true;
  return true;//规定时间已经用完了 需要跳出
}

function onUncaughtError(error: mixed) {
  invariant(
    nextFlushedRoot !== null,
    'Should be working on a root. This error is likely caused by a bug in ' +
      'React. Please file an issue.',
  );
  // Unschedule this root so we don't work on it again until there's
  // another update.
  nextFlushedRoot.expirationTime = NoWork;
  if (!hasUnhandledError) {
    hasUnhandledError = true;
    unhandledError = error;
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
function batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return fn(a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
function unbatchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  if (isBatchingUpdates && !isUnbatchingUpdates) {
    isUnbatchingUpdates = true;
    try {
      return fn(a);
    } finally {
      isUnbatchingUpdates = false;
    }
  }
  return fn(a);
}

// TODO: Batching should be implemented at the renderer level, not within
// the reconciler.
function flushSync<A, R>(fn: (a: A) => R, a: A): R {
  invariant(
    !isRendering,
    'flushSync was called from inside a lifecycle method. It cannot be ' +
      'called when React is already rendering.',
  );
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return syncUpdates(fn, a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    performSyncWork();
  }
}

function interactiveUpdates<A, B, R>(fn: (A, B) => R, a: A, b: B): R {
  if (isBatchingInteractiveUpdates) {
    return fn(a, b);
  }
  // If there are any pending interactive updates, synchronously flush them.
  // This needs to happen before we read any handlers, because the effect of
  // the previous event may influence which handlers are called during
  // this event.
  if (
    !isBatchingUpdates &&
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, null);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
  const previousIsBatchingInteractiveUpdates = isBatchingInteractiveUpdates;
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingInteractiveUpdates = true;
  isBatchingUpdates = true;
  try {
    return fn(a, b);
  } finally {
    isBatchingInteractiveUpdates = previousIsBatchingInteractiveUpdates;
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

function flushInteractiveUpdates() {
  if (
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, null);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
}

function flushControlled(fn: () => mixed): void {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    syncUpdates(fn);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

export {
  requestCurrentTime,
  computeExpirationForFiber,
  captureCommitPhaseError,
  onUncaughtError,
  renderDidSuspend,
  renderDidError,
  retrySuspendedRoot,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  scheduleWork,
  requestWork,
  flushRoot,
  batchedUpdates,
  unbatchedUpdates,
  flushSync,
  flushControlled,
  deferredUpdates,
  syncUpdates,
  interactiveUpdates,
  flushInteractiveUpdates,
  computeUniqueAsyncExpiration,
};
