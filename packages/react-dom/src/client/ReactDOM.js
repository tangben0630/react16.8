

import type {ReactNodeList} from 'shared/ReactTypes';
// TODO: This type is shared between the reconciler and ReactDOM, but will
// eventually be lifted out to the renderer.
import type {
  FiberRoot,
  Batch as FiberRootBatch,
} from 'react-reconciler/src/ReactFiberRoot';
import type {Container} from './ReactDOMHostConfig';

import '../shared/checkReact';
import './ReactDOMClientInjection';

import * as DOMRenderer from 'react-reconciler/inline.dom';
import * as ReactPortal from 'shared/ReactPortal';
import {canUseDOM} from 'shared/ExecutionEnvironment';
import * as ReactGenericBatching from 'events/ReactGenericBatching';
import * as ReactControlledComponent from 'events/ReactControlledComponent';
import * as EventPluginHub from 'events/EventPluginHub';
import * as EventPluginRegistry from 'events/EventPluginRegistry';
import * as EventPropagators from 'events/EventPropagators';
import * as ReactInstanceMap from 'shared/ReactInstanceMap';
import ReactVersion from 'shared/ReactVersion';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import {enableStableConcurrentModeAPIs} from 'shared/ReactFeatureFlags';

import * as ReactDOMComponentTree from './ReactDOMComponentTree';
import {restoreControlledState} from './ReactDOMComponent';
import * as ReactDOMEventListener from '../events/ReactDOMEventListener';
import {
  ELEMENT_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
} from '../shared/HTMLNodeType';
import {ROOT_ATTRIBUTE_NAME} from '../shared/DOMProperty';

let didWarnAboutUnstableCreatePortal = false;

ReactControlledComponent.setRestoreImplementation(restoreControlledState);

export type DOMContainer =
  | (Element & {
      _reactRootContainer: ?Root,
    })
  | (Document & {
      _reactRootContainer: ?Root,
    });

type Batch = FiberRootBatch & {
  render(children: ReactNodeList): Work,
  then(onComplete: () => mixed): void,
  commit(): void,

  // The ReactRoot constructor is hoisted but the prototype methods are not. If
  // we move ReactRoot to be above ReactBatch, the inverse error occurs.
  // $FlowFixMe Hoisting issue.
  _root: Root,
  _hasChildren: boolean,
  _children: ReactNodeList,

  _callbacks: Array<() => mixed> | null,
  _didComplete: boolean,
};

type Root = {
  render(children: ReactNodeList, callback: ?() => mixed): Work,
  unmount(callback: ?() => mixed): Work,
  legacy_renderSubtreeIntoContainer(
    parentComponent: ?React$Component<any, any>,
    children: ReactNodeList,
    callback: ?() => mixed,
  ): Work,
  createBatch(): Batch,

  _internalRoot: FiberRoot,
};

function ReactBatch(root: ReactRoot) {
  const expirationTime = DOMRenderer.computeUniqueAsyncExpiration();
  this._expirationTime = expirationTime;
  this._root = root;
  this._next = null;
  this._callbacks = null;
  this._didComplete = false;
  this._hasChildren = false;
  this._children = null;
  this._defer = true;
}
ReactBatch.prototype.render = function(children: ReactNodeList) {
  invariant(
    this._defer,
    'batch.render: Cannot render a batch that already committed.',
  );
  this._hasChildren = true;
  this._children = children;
  const internalRoot = this._root._internalRoot;
  const expirationTime = this._expirationTime;
  const work = new ReactWork();
  DOMRenderer.updateContainerAtExpirationTime(
    children,
    internalRoot,
    null,
    expirationTime,
    work._onCommit,
  );
  return work;
};
ReactBatch.prototype.then = function(onComplete: () => mixed) {
  if (this._didComplete) {
    onComplete();
    return;
  }
  let callbacks = this._callbacks;
  if (callbacks === null) {
    callbacks = this._callbacks = [];
  }
  callbacks.push(onComplete);
};
ReactBatch.prototype.commit = function() {
  const internalRoot = this._root._internalRoot;
  let firstBatch = internalRoot.firstBatch;
  invariant(
    this._defer && firstBatch !== null,
    'batch.commit: Cannot commit a batch multiple times.',
  );

  if (!this._hasChildren) {
    // This batch is empty. Return.
    this._next = null;
    this._defer = false;
    return;
  }

  let expirationTime = this._expirationTime;

  // Ensure this is the first batch in the list.
  if (firstBatch !== this) {
    // This batch is not the earliest batch. We need to move it to the front.
    // Update its expiration time to be the expiration time of the earliest
    // batch, so that we can flush it without flushing the other batches.
    if (this._hasChildren) {
      expirationTime = this._expirationTime = firstBatch._expirationTime;
      // Rendering this batch again ensures its children will be the final state
      // when we flush (updates are processed in insertion order: last
      // update wins).
      // TODO: This forces a restart. Should we print a warning?
      this.render(this._children);
    }

    // Remove the batch from the list.
    let previous = null;
    let batch = firstBatch;
    while (batch !== this) {
      previous = batch;
      batch = batch._next;
    }
    invariant(
      previous !== null,
      'batch.commit: Cannot commit a batch multiple times.',
    );
    previous._next = batch._next;

    // Add it to the front.
    this._next = firstBatch;
    firstBatch = internalRoot.firstBatch = this;
  }

  // Synchronously flush all the work up to this batch's expiration time.
  this._defer = false;
  DOMRenderer.flushRoot(internalRoot, expirationTime);

  // Pop the batch from the list.
  const next = this._next;
  this._next = null;
  firstBatch = internalRoot.firstBatch = next;

  // Append the next earliest batch's children to the update queue.
  if (firstBatch !== null && firstBatch._hasChildren) {
    firstBatch.render(firstBatch._children);
  }
};
ReactBatch.prototype._onComplete = function() {
  if (this._didComplete) {
    return;
  }
  this._didComplete = true;
  const callbacks = this._callbacks;
  if (callbacks === null) {
    return;
  }
  // TODO: Error handling.
  for (let i = 0; i < callbacks.length; i++) {
    const callback = callbacks[i];
    callback();
  }
};

type Work = {
  then(onCommit: () => mixed): void,
  _onCommit: () => void,
  _callbacks: Array<() => mixed> | null,
  _didCommit: boolean,
};

function ReactWork() {
  this._callbacks = null;
  this._didCommit = false;
  // TODO: Avoid need to bind by replacing callbacks in the update queue with
  // list of Work objects.
  this._onCommit = this._onCommit.bind(this);
}
ReactWork.prototype.then = function(onCommit: () => mixed): void {
  if (this._didCommit) {
    onCommit();
    return;
  }
  let callbacks = this._callbacks;
  if (callbacks === null) {
    callbacks = this._callbacks = [];
  }
  callbacks.push(onCommit);
};
ReactWork.prototype._onCommit = function(): void {
  if (this._didCommit) {
    return;
  }
  this._didCommit = true;
  const callbacks = this._callbacks;
  if (callbacks === null) {
    return;
  }
  // TODO: Error handling.
  for (let i = 0; i < callbacks.length; i++) {
    const callback = callbacks[i];
    invariant(
      typeof callback === 'function',
      'Invalid argument passed as callback. Expected a function. Instead ' +
        'received: %s',
      callback,
    );
    callback();
  }
};

function ReactRoot(
  container: Container,
  isConcurrent: boolean,
  hydrate: boolean,
) {
  //创建节点，创建了一个 FiberRoot   挂载在了 this上面
  const root = DOMRenderer.createContainer(container, isConcurrent, hydrate);
  //创建节点，创建了一个 FiberRoot   挂载在了 this上面
  this._internalRoot = root;
}
ReactRoot.prototype.render = function(
  children: ReactNodeList,
  callback: ?() => mixed,
): Work {
  const root = this._internalRoot;
  const work = new ReactWork();
  callback = callback === undefined ? null : callback;
  if (callback !== null) {
    work.then(callback);
  }
  DOMRenderer.updateContainer(children, root, null, work._onCommit);
  return work;
};
ReactRoot.prototype.unmount = function(callback: ?() => mixed): Work {
  const root = this._internalRoot;
  const work = new ReactWork();
  callback = callback === undefined ? null : callback;
  if (callback !== null) {
    work.then(callback);
  }
  DOMRenderer.updateContainer(null, root, null, work._onCommit);
  return work;
};
ReactRoot.prototype.legacy_renderSubtreeIntoContainer = function(
  parentComponent: ?React$Component<any, any>,
  children: ReactNodeList,
  callback: ?() => mixed,
): Work {
  const root = this._internalRoot;
  const work = new ReactWork();
  callback = callback === undefined ? null : callback;
  if (callback !== null) {
    work.then(callback);
  }
  DOMRenderer.updateContainer(children, root, parentComponent, work._onCommit);
  return work;
};
ReactRoot.prototype.createBatch = function(): Batch {
  const batch = new ReactBatch(this);
  const expirationTime = batch._expirationTime;

  const internalRoot = this._internalRoot;
  const firstBatch = internalRoot.firstBatch;
  if (firstBatch === null) {
    internalRoot.firstBatch = batch;
    batch._next = null;
  } else {
    // Insert sorted by expiration time then insertion order
    let insertAfter = null;
    let insertBefore = firstBatch;
    while (
      insertBefore !== null &&
      insertBefore._expirationTime <= expirationTime
    ) {
      insertAfter = insertBefore;
      insertBefore = insertBefore._next;
    }
    batch._next = insertBefore;
    if (insertAfter !== null) {
      insertAfter._next = batch;
    }
  }

  return batch;
};
function isValidContainer(node) {
  return !!(
    node &&
    (node.nodeType === ELEMENT_NODE ||
      node.nodeType === DOCUMENT_NODE ||
      node.nodeType === DOCUMENT_FRAGMENT_NODE ||
      (node.nodeType === COMMENT_NODE &&
        node.nodeValue === ' react-mount-point-unstable '))
  );
}

function getReactRootElementInContainer(container: any) {
  if (!container) {
    return null;
  }

  if (container.nodeType === DOCUMENT_NODE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

function shouldHydrateDueToLegacyHeuristic(container) {
  //container 有值的话  rootElement 是有值的
  const rootElement = getReactRootElementInContainer(container);
  return !!(
    rootElement &&
    rootElement.nodeType === ELEMENT_NODE &&
    rootElement.hasAttribute(ROOT_ATTRIBUTE_NAME)//旧版本的ssr 会在div上标记一个私有属性
  );
}

ReactGenericBatching.setBatchingImplementation(
  DOMRenderer.batchedUpdates,
  DOMRenderer.interactiveUpdates,
  DOMRenderer.flushInteractiveUpdates,
);


function legacyCreateRootFromDOMContainer(
  container: DOMContainer,
  forceHydrate: boolean, //一个 boolean 是否调和原来存在的dom 节点，在服务端渲染时候用 
): Root {
  const shouldHydrate =
    forceHydrate || shouldHydrateDueToLegacyHeuristic(container);
  // First clear any existing content.
  if (!shouldHydrate) {
    let rootSibling;
    while ((rootSibling = container.lastChild)) {
      container.removeChild(rootSibling);
    }
  }
  // Legacy roots are not async by default.
  const isConcurrent = false;
  return new ReactRoot(container, isConcurrent, shouldHydrate);
}

function legacyRenderSubtreeIntoContainer(
  parentComponent: ?React$Component<any, any>,//第一个是 null
  children: ReactNodeList, // element
  container: DOMContainer,//容器
  forceHydrate: boolean,//false  用来决定是否会调和原来存在于container里面的dom节点
  //是否需要复用这些节点
  callback: ?Function,//
) {
  // TODO: Ensure all entry points contain this check
  invariant(
    isValidContainer(container),
    'Target container is not a DOM element.',
  );

  // 从dom节点上面获取 root，第一次渲染，是不存在的
  let root: Root = (container._reactRootContainer: any);
  if (!root) {
    // 初次，不存在 root
    root = container._reactRootContainer = legacyCreateRootFromDOMContainer(
      container,
      forceHydrate, //false  ssr 为 true
    );
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = DOMRenderer.getPublicRootInstance(root._internalRoot);
        originalCallback.call(instance);
      };
    }
    // Initial mount should not be batched.
    DOMRenderer.unbatchedUpdates(() => {
      if (parentComponent != null) {
        root.legacy_renderSubtreeIntoContainer(
          parentComponent,
          children,
          callback,
        );
      } else {
        root.render(children, callback);
      }
    });
  } else {
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = DOMRenderer.getPublicRootInstance(root._internalRoot);
        originalCallback.call(instance);
      };
    }
    // Update
    if (parentComponent != null) {
      root.legacy_renderSubtreeIntoContainer(
        parentComponent,
        children,
        callback,
      );
    } else {
      root.render(children, callback);
    }
  }
  return DOMRenderer.getPublicRootInstance(root._internalRoot);
}

function createPortal(
  children: ReactNodeList,
  container: DOMContainer,
  key: ?string = null,
) {
  invariant(
    isValidContainer(container),
    'Target container is not a DOM element.',
  );
  // TODO: pass ReactDOM portal implementation as third argument
  return ReactPortal.createPortal(children, container, null, key);
}

const ReactDOM: Object = {
  createPortal,
  findDOMNode(
    componentOrElement: Element | ?React$Component<any, any>,
  ): null | Element | Text {
    if (componentOrElement == null) {
      return null;
    }
    if ((componentOrElement: any).nodeType === ELEMENT_NODE) {
      return (componentOrElement: any);
    }
    return DOMRenderer.findHostInstance(componentOrElement);
  },

  hydrate(element: React$Node, container: DOMContainer, callback: ?Function) {
    // TODO: throw or warn if we couldn't hydrate?
    return legacyRenderSubtreeIntoContainer(
      null,
      element,
      container,
      true,
      callback,
    );
  },

  render(
    element: React$Element<any>, 
    container: DOMContainer, //容器，就是我们要挂载到哪个dom节点上面
    callback: ?Function, //渲染结束后 会调用这个callback
  ) {
    return legacyRenderSubtreeIntoContainer(
      null,
      element,
      container,//挂载的那个dom节点
      false,
      callback,
    );
  },

  unstable_renderSubtreeIntoContainer(
    parentComponent: React$Component<any, any>,
    element: React$Element<any>,
    containerNode: DOMContainer,
    callback: ?Function,
  ) {
    invariant(
      parentComponent != null && ReactInstanceMap.has(parentComponent),
      'parentComponent must be a valid React Component',
    );
    return legacyRenderSubtreeIntoContainer(
      parentComponent,
      element,
      containerNode,
      false,
      callback,
    );
  },

  unmountComponentAtNode(container: DOMContainer) {
    invariant(
      isValidContainer(container),
      'unmountComponentAtNode(...): Target container is not a DOM element.',
    );

    if (container._reactRootContainer) {
      // Unmount should not be batched.
      DOMRenderer.unbatchedUpdates(() => {
        legacyRenderSubtreeIntoContainer(null, null, container, false, () => {
          container._reactRootContainer = null;
        });
      });
      // If you call unmountComponentAtNode twice in quick succession, you'll
      // get `true` twice. That's probably fine?
      return true;
    } else {
      return false;
    }
  },

  // Temporary alias since we already shipped React 16 RC with it.
  // TODO: remove in React 17.
  unstable_createPortal(...args) {
    if (!didWarnAboutUnstableCreatePortal) {
      didWarnAboutUnstableCreatePortal = true;
    }
    return createPortal(...args);
  },

  unstable_batchedUpdates: DOMRenderer.batchedUpdates,

  unstable_interactiveUpdates: DOMRenderer.interactiveUpdates,

  flushSync: DOMRenderer.flushSync,

  unstable_flushControlled: DOMRenderer.flushControlled,

  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    // Keep in sync with ReactDOMUnstableNativeDependencies.js
    // and ReactTestUtils.js. This is an array for better minification.
    Events: [
      ReactDOMComponentTree.getInstanceFromNode,
      ReactDOMComponentTree.getNodeFromInstance,
      ReactDOMComponentTree.getFiberCurrentPropsFromNode,
      EventPluginHub.injection.injectEventPluginsByName,
      EventPluginRegistry.eventNameDispatchConfigs,
      EventPropagators.accumulateTwoPhaseDispatches,
      EventPropagators.accumulateDirectDispatches,
      ReactControlledComponent.enqueueStateRestore,
      ReactControlledComponent.restoreStateIfNeeded,
      ReactDOMEventListener.dispatchEvent,
      EventPluginHub.runEventsInBatch,
    ],
  },
};

type RootOptions = {
  hydrate?: boolean,
};

function createRoot(container: DOMContainer, options?: RootOptions): ReactRoot {
  invariant(
    isValidContainer(container),
    'unstable_createRoot(...): Target container is not a DOM element.',
  );
  const hydrate = options != null && options.hydrate === true;
  return new ReactRoot(container, true, hydrate);
}
if (enableStableConcurrentModeAPIs) {
  ReactDOM.createRoot = createRoot;
} else {
  ReactDOM.unstable_createRoot = createRoot;
}
export default ReactDOM;
