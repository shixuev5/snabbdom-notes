/* global module, document, Node */
import {Module} from './modules/module';
import {Hooks} from './hooks';
import vnode, {VNode, VNodeData, Key} from './vnode';
import * as is from './is';
import htmlDomApi, {DOMAPI} from './htmldomapi';

function isUndef(s: any): boolean { return s === undefined; }
function isDef(s: any): boolean { return s !== undefined; }

type VNodeQueue = Array<VNode>;

const emptyNode = vnode('', {}, [], undefined, undefined);

function sameVnode(vnode1: VNode, vnode2: VNode): boolean {
  return vnode1.key === vnode2.key && vnode1.sel === vnode2.sel;
}

function isVnode(vnode: any): vnode is VNode {
  return vnode.sel !== undefined;
}

type KeyToIndexMap = {[key: string]: number};

type ArraysOf<T> = {
  [K in keyof T]: (T[K])[];
}

type ModuleHooks = ArraysOf<Module>;

function createKeyToOldIdx(children: Array<VNode>, beginIdx: number, endIdx: number): KeyToIndexMap {
  let i: number, map: KeyToIndexMap = {}, key: Key | undefined, ch;
  for (i = beginIdx; i <= endIdx; ++i) {
    ch = children[i];
    if (ch != null) {
      key = ch.key;
      if (key !== undefined) map[key] = i;
    }
  }
  return map;
}

const hooks: (keyof Module)[] = ['create', 'update', 'remove', 'destroy', 'pre', 'post'];

export {h} from './h';
export {thunk} from './thunk';

export function init(modules: Array<Partial<Module>>, domApi?: DOMAPI) {
  // cbs用于保存modules中注册的hook回调函数
  let i: number, j: number, cbs = ({} as ModuleHooks);

  const api: DOMAPI = domApi !== undefined ? domApi : htmlDomApi;

  // 将modules中注册的回调函数push进相对应的hook回调函数数组中保存
  for (i = 0; i < hooks.length; ++i) {
    cbs[hooks[i]] = [];
    for (j = 0; j < modules.length; ++j) {
      const hook = modules[j][hooks[i]];
      if (hook !== undefined) {
        (cbs[hooks[i]] as Array<any>).push(hook);
      }
    }
  }

  function emptyNodeAt(elm: Element) {
    const id = elm.id ? '#' + elm.id : '';
    const c = elm.className ? '.' + elm.className.split(' ').join('.') : '';
    return vnode(api.tagName(elm).toLowerCase() + id + c, {}, [], undefined, elm);
  }

  function createRmCb(childElm: Node, listeners: number) {
    return function rmCb() {
      if (--listeners === 0) {
        const parent = api.parentNode(childElm);
        api.removeChild(parent, childElm);
      }
    };
  }

  // 根据Vnode创建Vnode.elm并返回
  function createElm(vnode: VNode, insertedVnodeQueue: VNodeQueue): Node {
    let i: any, data = vnode.data;
    if (data !== undefined) {
      if (isDef(i = data.hook) && isDef(i = i.init)) {
        // 当Vnode节点data.hook.init函数定义时调用，传递Vnode作为参数
        i(vnode);
        data = vnode.data;
      }
    }

    let children = vnode.children, sel = vnode.sel;
    if (sel === '!') {
      if (isUndef(vnode.text)) {
        vnode.text = '';
      }
      // 创建注释节点
      vnode.elm = api.createComment(vnode.text as string);
    } else if (sel !== undefined) {
      const hashIdx = sel.indexOf('#');
      const dotIdx = sel.indexOf('.', hashIdx);
      const hash = hashIdx > 0 ? hashIdx : sel.length;
      const dot = dotIdx > 0 ? dotIdx : sel.length;
      // 根据Vnode.sel解析出tag
      const tag = hashIdx !== -1 || dotIdx !== -1 ? sel.slice(0, Math.min(hash, dot)) : sel;
      // 根据tag创建对应的dom节点
      const elm = vnode.elm = isDef(data) && isDef(i = (data as VNodeData).ns) ? api.createElementNS(i, tag)
                                                                               : api.createElement(tag);
      // 根据Vnode.sel添加id和class                                                                       
      if (hash < dot) elm.setAttribute('id', sel.slice(hash + 1, dot));
      if (dotIdx > 0) elm.setAttribute('class', sel.slice(dot + 1).replace(/\./g, ' '));

      // 执行 modules 中注册的 create hook函数,传入空Vnode节点和当前Vnode节点
      for (i = 0; i < cbs.create.length; ++i) cbs.create[i](emptyNode, vnode);

      // 如果children属性是Vnode节点数组，则遍历children数组递归调用CreateElm函数创建dom添加到子节点中
      if (is.array(children)) {
        for (i = 0; i < children.length; ++i) {
          const ch = children[i];
          if (ch != null) {
            api.appendChild(elm, createElm(ch as VNode, insertedVnodeQueue));
          }
        }
      } else if (is.primitive(vnode.text)) {
        // 当Vnode.text时原始值类型时，创建文本节点添加到子节点中
        api.appendChild(elm, api.createTextNode(vnode.text));
      }

      i = (vnode.data as VNodeData).hook;
      if (isDef(i)) {
        // 执行 Vnode节点 data.hook.create 函数，传入空Vnode节点和当前Vnode节点
        if (i.create) i.create(emptyNode, vnode);
        // 如果 Vnode节点 data.hook.insert 函数存在，向插入Vnode节点队列中插入当前Vnode节点
        if (i.insert) insertedVnodeQueue.push(vnode);
      }
    } else {
      // 当Vnode.sel不存在的时候，创建文本节点
      vnode.elm = api.createTextNode(vnode.text as string);
    }
    // 返回创建的dom节点对象
    return vnode.elm;
  }

  // 根据Vnode节点创建dom依次插入到before节点之前
  function addVnodes(parentElm: Node,
                     before: Node | null,
                     vnodes: Array<VNode>,
                     startIdx: number,
                     endIdx: number,
                     insertedVnodeQueue: VNodeQueue) {
    for (; startIdx <= endIdx; ++startIdx) {
      const ch = vnodes[startIdx];
      if (ch != null) {
        api.insertBefore(parentElm, createElm(ch, insertedVnodeQueue), before);
      }
    }
  }

  function invokeDestroyHook(vnode: VNode) {
    let i: any, j: number, data = vnode.data;
    if (data !== undefined) {
      // 执行Vnode节点data.hook.destroy函数，并传入当前Vnode节点
      if (isDef(i = data.hook) && isDef(i = i.destroy)) i(vnode);
      // 执行 modules 中注册的 destroy hook函数
      for (i = 0; i < cbs.destroy.length; ++i) cbs.destroy[i](vnode);
      if (vnode.children !== undefined) {
        for (j = 0; j < vnode.children.length; ++j) {
          i = vnode.children[j];
          if (i != null && typeof i !== "string") {
            // 直接点递归调用
            invokeDestroyHook(i);
          }
        }
      }
    }
  }

  function removeVnodes(parentElm: Node,
                        vnodes: Array<VNode>,
                        startIdx: number,
                        endIdx: number): void {
    for (; startIdx <= endIdx; ++startIdx) {
      let i: any, listeners: number, rm: () => void, ch = vnodes[startIdx];
      if (ch != null) {
        if (isDef(ch.sel)) {
          // 执行Vnode data.hook.destroy 以及 modules中定义的destroy回调函数
          invokeDestroyHook(ch);

          listeners = cbs.remove.length + 1;
          // 返回移除dom函数
          rm = createRmCb(ch.elm as Node, listeners);
          // 执行 modules 中注册的 remove hook函数
          for (i = 0; i < cbs.remove.length; ++i) cbs.remove[i](ch, rm);
          // 执行Vnode data.hook.remove函数 传入Vnode及移除dom函数，不存在则直接调用移除dom函数
          if (isDef(i = ch.data) && isDef(i = i.hook) && isDef(i = i.remove)) {
            i(ch, rm);
          } else {
            rm();
          }
        } else {
          // 不包含选择器的文本节点直接移除
          api.removeChild(parentElm, ch.elm as Node);
        }
      }
    }
  }

  // 根据新旧Vnode列表的差异，更新dom(保持Vnode与dom的映射关系) 旧Vnode对应当前dom状态
  function updateChildren(parentElm: Node,
                          oldCh: Array<VNode>,
                          newCh: Array<VNode>,
                          insertedVnodeQueue: VNodeQueue) {
    let oldStartIdx = 0, newStartIdx = 0;
    let oldEndIdx = oldCh.length - 1;
    let oldStartVnode = oldCh[0];
    let oldEndVnode = oldCh[oldEndIdx];
    let newEndIdx = newCh.length - 1;
    let newStartVnode = newCh[0];
    let newEndVnode = newCh[newEndIdx];
    let oldKeyToIdx: any;
    let idxInOld: number;
    let elmToMove: VNode;
    let before: any;

    // 原则：移动newStartIdx指针 当newStartIdx > newEndIdx时，新Vnode列表遍历完成，代表dom更新完成 或者 oldStartIdx > oldEndIdx 代表已无dom进行复用，未遍历的新Vnode节点都是需要新增的。
    while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
      // 当Vnode节点为null时，向前或者向后移动指针
      // 当sel及key相同时，认为该节点不需要移动，调用pathVnode函数更新子节点，并移动指针
      // 
      if (oldStartVnode == null) {
        oldStartVnode = oldCh[++oldStartIdx];
      } else if (oldEndVnode == null) {
        oldEndVnode = oldCh[--oldEndIdx];
      } else if (newStartVnode == null) {
        newStartVnode = newCh[++newStartIdx];
      } else if (newEndVnode == null) {
        newEndVnode = newCh[--newEndIdx];
      } else if (sameVnode(oldStartVnode, newStartVnode)) {
        patchVnode(oldStartVnode, newStartVnode, insertedVnodeQueue);
        oldStartVnode = oldCh[++oldStartIdx];
        newStartVnode = newCh[++newStartIdx];
      } else if (sameVnode(oldEndVnode, newEndVnode)) {
        patchVnode(oldEndVnode, newEndVnode, insertedVnodeQueue);
        oldEndVnode = oldCh[--oldEndIdx];
        newEndVnode = newCh[--newEndIdx];
      } else if (sameVnode(oldStartVnode, newEndVnode)) { // Vnode moved right
        patchVnode(oldStartVnode, newEndVnode, insertedVnodeQueue);
        api.insertBefore(parentElm, oldStartVnode.elm as Node, api.nextSibling(oldEndVnode.elm as Node));
        oldStartVnode = oldCh[++oldStartIdx];
        newEndVnode = newCh[--newEndIdx];
      } else if (sameVnode(oldEndVnode, newStartVnode)) { // Vnode moved left
        patchVnode(oldEndVnode, newStartVnode, insertedVnodeQueue);
        api.insertBefore(parentElm, oldEndVnode.elm as Node, oldStartVnode.elm as Node);
        oldEndVnode = oldCh[--oldEndIdx];
        newStartVnode = newCh[++newStartIdx];
      } else {
        // 正常情况下，通过 newStartVnode.key 判断在旧的Vnode列表中是否存在，
        if (oldKeyToIdx === undefined) {
          // 返回key到index的映射 {key: index}
          oldKeyToIdx = createKeyToOldIdx(oldCh, oldStartIdx, oldEndIdx);
        }
        // 通过key判断新Vnode节点在旧Vnode列表中是否存在
        idxInOld = oldKeyToIdx[newStartVnode.key as string];
        if (isUndef(idxInOld)) {
          // 不存在则在oldStartVnode.elm前面插入dom，并移动newStartIdx指针
          api.insertBefore(parentElm, createElm(newStartVnode, insertedVnodeQueue), oldStartVnode.elm as Node);
          newStartVnode = newCh[++newStartIdx];
        } else {
          elmToMove = oldCh[idxInOld];
          if (elmToMove.sel !== newStartVnode.sel) {
            // 存在但是sel不相等，调用 createElm 重新创建dom
            api.insertBefore(parentElm, createElm(newStartVnode, insertedVnodeQueue), oldStartVnode.elm as Node);
          } else {
            // 存在并且sel相等，复用dom
            patchVnode(elmToMove, newStartVnode, insertedVnodeQueue);
            oldCh[idxInOld] = undefined as any;
            api.insertBefore(parentElm, (elmToMove.elm as Node), oldStartVnode.elm as Node);
          }
          // 移动newStartIdx指针
          newStartVnode = newCh[++newStartIdx];
        }
      }
    }
    // 旧的Vnode列表或者新的Vnode列表已遍历完成
    if (oldStartIdx <= oldEndIdx || newStartIdx <= newEndIdx) {
      if (oldStartIdx > oldEndIdx) {
        // 旧的Vnode列表义遍历完成，此时未遍历的新Vnode节点都是需要新增的
        before = newCh[newEndIdx+1] == null ? null : newCh[newEndIdx+1].elm;
        addVnodes(parentElm, before, newCh, newStartIdx, newEndIdx, insertedVnodeQueue);
      } else {
        // 新的Vnode列表已遍历完成，未遍历的旧的Vnode节点都是需要被移除的
        removeVnodes(parentElm, oldCh, oldStartIdx, oldEndIdx);
      }
    }
  }

  // 根据Vnode的差异更新子节点
  function patchVnode(oldVnode: VNode, vnode: VNode, insertedVnodeQueue: VNodeQueue) {
    let i: any, hook: any;
    // 执行Vnode节点data.hook.prepatch函数，并传入旧的Vnode节点及当前Vnode节点
    if (isDef(i = vnode.data) && isDef(hook = i.hook) && isDef(i = hook.prepatch)) {
      i(oldVnode, vnode);
    }
    const elm = vnode.elm = (oldVnode.elm as Node);
    let oldCh = oldVnode.children;
    let ch = vnode.children;
    if (oldVnode === vnode) return;  // ？？？
    if (vnode.data !== undefined) {
      // 执行 modules 中注册的 update hook函数
      for (i = 0; i < cbs.update.length; ++i) cbs.update[i](oldVnode, vnode);
      i = vnode.data.hook;
      // 执行Vnode节点data.hook.update函数，并传入旧的Vnode节点及当前Vnode节点
      if (isDef(i) && isDef(i = i.update)) i(oldVnode, vnode);
    }
    // Vnode.text未定义时存在四种情况 
    if (isUndef(vnode.text)) {
      if (isDef(oldCh) && isDef(ch)) {
        // 局部更新子节点 重点！！！
        if (oldCh !== ch) updateChildren(elm, oldCh as Array<VNode>, ch as Array<VNode>, insertedVnodeQueue);
      } else if (isDef(ch)) {
        // 旧Vnode.children未定义，先清除文本内容，再添加新的子节点
        if (isDef(oldVnode.text)) api.setTextContent(elm, '');
        addVnodes(elm, null, ch as Array<VNode>, 0, (ch as Array<VNode>).length - 1, insertedVnodeQueue);
      } else if (isDef(oldCh)) {
        // 新Vnode.children未定义，移除所有子节点
        removeVnodes(elm, oldCh as Array<VNode>, 0, (oldCh as Array<VNode>).length - 1);
      } else if (isDef(oldVnode.text)) {
        // 清除文本内容
        api.setTextContent(elm, '');
      }
    } else if (oldVnode.text !== vnode.text) {
      // 更新文本内容
      api.setTextContent(elm, vnode.text as string);
    }
    // 执行Vnode节点data.hook.postpatch函数，并传入旧的Vnode节点及当前Vnode节点
    if (isDef(hook) && isDef(i = hook.postpatch)) {
      i(oldVnode, vnode);
    }
  }
  
  // 按 pre -> create -> update -> remove -> destroy -> post 的顺序调用hook函数队列
  return function patch(oldVnode: VNode | Element, vnode: VNode): VNode {
    let i: number, elm: Node, parent: Node;
    const insertedVnodeQueue: VNodeQueue = [];
    // 执行 modules 中注册的 pre hook函数
    for (i = 0; i < cbs.pre.length; ++i) cbs.pre[i]();
    
    // 判断是否是Vnode对象
    if (!isVnode(oldVnode)) {
      // 根据传入的Dom对象生成Vnode对象
      oldVnode = emptyNodeAt(oldVnode);
    }

    if (sameVnode(oldVnode, vnode)) {
      // 更新Vnode的子节点
      patchVnode(oldVnode, vnode, insertedVnodeQueue);
    } else {
      // 保存之前的dom节点及其父元素
      elm = oldVnode.elm as Node;
      parent = api.parentNode(elm);
      
      // 根据 Vnode 创建dom，并将 Vnode data.hook.insert存在的节点添加到 insertedVnodeQueue
      createElm(vnode, insertedVnodeQueue);

      if (parent !== null) {
        // 在旧的dom节点之前插入新的dom节点
        api.insertBefore(parent, vnode.elm as Node, api.nextSibling(elm));
        // 移除旧的dom节点
        removeVnodes(parent, [oldVnode], 0, 0);
      }
    }
    
    // 执行插入Vnode节点data.hook.insert函数，并传入当前Vnode节点
    for (i = 0; i < insertedVnodeQueue.length; ++i) {
      (((insertedVnodeQueue[i].data as VNodeData).hook as Hooks).insert as any)(insertedVnodeQueue[i]);
    }
    // 执行 modules 中注册的 post hook函数
    for (i = 0; i < cbs.post.length; ++i) cbs.post[i]();

    return vnode;
  };
}
