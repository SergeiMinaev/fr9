let ID_COUNTER = 0;
const RESERVED_ATTRS = ['@if', '@else', '@for'];
const ID_ATTR = '_i';
const LASTIF_ATTR = '_lastif';
const PLACEHOLDER_ATTR = '_placeholder';
const CREATED_ATTR = '_created';


export function run(c, parent=undefined) {
	const runner = new Runner(c);
	c.$emit = (name, detail) => emit(c.rootNode, name, detail);
	c.$getRoute = () => getRoute(c);
	if (c.onCreated) c.onCreated();
	runner.run();
}

function getRoute(c) {
	if (c.__route) return c.__route;
	return c.$parent.getRoute(c.$parent);
}

function getComponent(current, compName) {
	if (current.components && current.components[compName]) return current.components[compName];
	if (!current.$parent) {
		console.error(`Unable to get component ${compName}. Did you forgot to register it?`);
		return;
	}
	return current.$parent.getComponent(current.$parent, compName);
}

class Runner {
	constructor(c) {
		this.c = c;
		this.isFirstRun = true;
		if (typeof c.rootNode == 'string') {
			this.rootNode = document.getElementById(c.rootNode);
			c.rootNode = this.rootNode;
		} else {
			this.rootNode = c.rootNode;
		}
		const tplEl = document.getElementById(c.tpl);
		if (!tplEl) { console.error(`Element ${c.tpl} not exists.`); }
		this.tpl = tplEl.content.cloneNode(true);
		this.context = {};
		this.render = () => this._render();
		window.interpolate = this.interpolate;
	}

	run() {
		this.prepareTpl();
		this.domTree = this.tpl.cloneNode(true);
		observer(this.render, this.c.tpl, this.isDeleted);
		if (this.c.routes) this.initRouter();
	}

	_render() {
		this.context = {};
		if (this.isFirstRun) {
			this.rootNode.append(this.tpl.cloneNode(true));
			if (this.c.onMounted) this.c.onMounted();
		}
		this.isFirstRun = false;
		this.processNodes(this.tpl, this.rootNode);
	}

	isDeleted = () => {
		return !this.isFirstRun && !this.rootNode.isConnected;
	}

	prepareTpl() {
		this.markNode(this.tpl);
	}

	markNode(node) {
		if (node.nodeName != '#document-fragment') {
			node.setAttribute(ID_ATTR, ID_COUNTER++);
		}
		Array.from(node.children).forEach(child => {
			const ignoredNodeNames = ['#text', '#comment'];
			if (!ignoredNodeNames.includes(child.nodeName)) {
				this.markNode(child);
			}
		});
	}

	processNodes(tplNode, domParent) {
		if (tplNode.nodeName != '#document-fragment') {
			domParent = this.processNode(tplNode, domParent);
		}
		if (domParent === false) {
			return;
		}
		// Чтобы нода с '@for' не обрабатывалась дважды.
		if (!tplNode.attributes?.['@for']) {
			this.processChildren(tplNode, domParent);
		}
	}

	processChildren(tplNode, domParent) {
		Array.from(tplNode.children).forEach(tplChild => {
			const ignoredNodeNames = ['#text', '#comment'];
			if (!ignoredNodeNames.includes(tplChild.nodeName)) {
				this.processNodes(tplChild, domParent);
			}
		});
	}

	processNode(tplNode, domParent, skipLoop=false) {
		const nodeId = tplNode.getAttribute(ID_ATTR);
		let domNode = domParent.querySelector(`[${ID_ATTR}="${nodeId}"]`);
		// Если domNode - undefined, нужно вернуть false. Случается при переключении между роутами.
		// TODO: Разобраться, почему domNode может не находиться.
		if (!domNode) return false;
		const isChanged = this.processIf(tplNode, domParent);
		if (isChanged) {
			this.processEvents(tplNode, domParent);
			return false;
		}
		this.processEvents(tplNode, domParent);

		const isCmpFound = this.processComponents(tplNode, domParent);
		if (isCmpFound) {
			return false;
		}
		// Если это элемент цикла, то атрибуты будут обрабатываться внутри processLoop.
		// До processLoop, скорее всего, контекст будет пустым и из-за этого будут ошибки интерполяции.
		if (!tplNode.attributes['@for']) {
			this.processAttrs(tplNode, domParent);
		}
		this.processRouteLinks(tplNode, domParent);
		const isRouteViewFound = this.processRoutes(tplNode, domParent, null, skipLoop);
		// Т.к. в processLoop делается свой processAttrs, то processLoop должен идти после processAttrs,
		// иначе уже после processLoop атрибуты обработаются снова и, при этом, index будет равен 0,
		// а фактический this.context будет соответствовать последнему index,
		// из-за чего первый dom-элемент обработается по значениям для последнего dom-элемента.
		if (!skipLoop) {
			this.processLoop(tplNode, domParent);
		}
		return domNode;
	}

	processComponents(tplNode, domParent) {
		if (!tplNode.nodeName.startsWith('C-')) return false;
		const compName = tplNode.nodeName.toLowerCase().replace('c-', '');
		const domNode = nodesById(domParent, nodeId(tplNode))[0];
		if (domNode.getAttribute(CREATED_ATTR)) {
			this.processComponentProps(domNode.__cmp, tplNode, domParent);
			return true;
		}
		const cmpClass = getComponent(this.c, compName);
		if (!cmpClass) {
			console.warn(`No component "${compName}" in`, this.c, 'and in parents.');
			return;
		}
		const cmp = new cmpClass();
		cmp.rootNode = domNode;
		cmp.$parent = this.c;
		domNode.__cmp = cmp;
		this.setComponentDefaults(domNode);
		const inner = cmp.rootNode.children[0];
		if (inner) cmp.rootNode.replaceWith(inner);
		this.processComponentProps(cmp, tplNode, domParent);
		run(cmp);
		return true;
	}

	setComponentDefaults(domNode) {
		domNode.setAttribute(CREATED_ATTR, '1');
		//domNode.style.display = 'contents';
	}

	// TODO: не работает @if='${!!state.refs[fieldSchema.ref.model_name]}',
	// работает только так @if='${state.refs && !!state.refs[fieldSchema.ref.model_name]}' .
	processIf(tplNode, domParent) {
		let isChanged = false;
		if (tplNode.attributes['@if']) {
			const domNode = nodesById(domParent, nodeId(tplNode))[0];
			const expr = tplNode.attributes['@if'].value;
			const isTrue = fixExprResult(this.interpolate(expr));
			if (!isTrue) {
				// Нода заменяется слотом только если ещё не заменена.
				if (!domNode.attributes[PLACEHOLDER_ATTR]) {
					const slot = document.createElement('slot');
					const nodeId = tplNode.getAttribute(ID_ATTR);
					slot.setAttribute(ID_ATTR, nodeId);
					slot.setAttribute(PLACEHOLDER_ATTR, 1);
					slot.setAttribute(LASTIF_ATTR, isTrue);
					domNode.replaceWith(slot);
					isChanged = true;
				} else {
					domNode.setAttribute(LASTIF_ATTR, isTrue);
					isChanged = true;
				}
			} else {
				// Если в данный момент в доме слот, он заменяется нужной нодой.
				if (domNode.attributes[PLACEHOLDER_ATTR]) {
					const newNode = tplNode.cloneNode(true);
					newNode.setAttribute(LASTIF_ATTR, isTrue);
					domNode.replaceWith(newNode);
					if (tplNode.nodeName.startsWith('C-')) {
						this.processNodes(tplNode, domParent);
					} else {
						this.processChildren(tplNode, domParent);
					}
					isChanged = true;
				} else {
					domNode.setAttribute(LASTIF_ATTR, isTrue);
					// Здесь не нужно делать isChanged true, иначе не срабатывает @click.
					// isChanged = true;
				}
			}
			domNode.removeAttribute('@if');
		} else if (tplNode.attributes['@else']) {
			const domNode = nodesById(domParent, nodeId(tplNode))[0];
			const ifNode = domNode.previousElementSibling;
			if (ifNode.getAttribute(LASTIF_ATTR) == 'true') {
				// Нода заменяется слотом только если ещё не заменена.
				if (!domNode.attributes[PLACEHOLDER_ATTR]) {
					const slot = document.createElement('slot');
					const nodeId = tplNode.getAttribute(ID_ATTR);
					slot.setAttribute(ID_ATTR, nodeId);
					slot.setAttribute(PLACEHOLDER_ATTR, 1);
					domNode.replaceWith(slot);
					isChanged = true;
				}
				isChanged = true;
			} else {
				// Если в данный момент в доме слот, он заменяется нужной нодой.
				if (domNode.attributes[PLACEHOLDER_ATTR]) {
					const newNode = tplNode.cloneNode(true);
					domNode.replaceWith(newNode);
					this.processChildren(tplNode, domParent);
					isChanged = true;
				}
				// Здесь не нужно делать isChanged true, иначе не срабатывает @click.
				// isChanged = true;
			}
			domNode.removeAttribute('@else');
		}
		return isChanged;
	}

	processLoop(tplNode, domParent) {
		if (tplNode.attributes['@for']) {
			const val = tplNode.attributes['@for'].value;
			const [itemNameIdx, srcName] = val.split(' in ').map(el => el.trim());
			const [itemName, itemIdx] = itemNameIdx.split(',').map(el => el.trim());
			let src = resolve(srcName, this.c, this);
			if (typeof(src) == 'function') src = src();
			if (src === undefined) console.warn(`${srcName} is undefined in`, this.c);
			let prevEl;
			for (let index = 0; index < src.length; index++) {
				this.context[itemName] = src[index];
				if (itemIdx) this.context[itemIdx] = index;
				let domEl = nodesById(domParent, nodeId(tplNode))[index];
				// Если нода является заглушкой, значит в предыдущем рендере массив был пустым.
				// Тогда заглушку нужно заменить полноценной нодой.
				if (domEl?.attributes[PLACEHOLDER_ATTR]) {
					const newNode = tplNode.cloneNode(true);
					domEl.replaceWith(newNode);
					domEl = newNode;
				}
				if (!prevEl) {
					prevEl = domEl;
					// Без этого, если цикл лежит внутри @if, все элементы, кроме первого, будут добавлены снаружи родителя.
					if (prevEl.parentElement) domParent = prevEl.parentElement;
				}
				if (!domEl) {
					domEl = tplNode.cloneNode(true);
					try {
						domParent.insertBefore(domEl, prevEl?.nextElementSibling);
						domEl.id = index;
					} catch (e) {
						console.error(e);
					}
					prevEl = domEl;
				} else {
					prevEl = domEl;
					domEl.id = index;
				}
				const skipLoop = true;
				this.processAttrs(tplNode, domParent, index);
				this.processChildren(tplNode, domEl);
				domEl.removeAttribute('@for');
			}
			// Удаление лишних нод.
			const domEls = nodesById(domParent, nodeId(tplNode));
			let domElsCnt = domEls.length;
			while (domElsCnt > src.length) {
				if (domElsCnt > 1) {
					domParent.removeChild(domEls[domElsCnt-1]);
				} else {
					// Если обрабатывается пустой массив, всё удалять не нужно. Иначе, когда
					// в массив добавятся элементы, добавление в DOM произойдёт в неправильном месте.
					// Поэтому нужно сохранять одну ноду-заглушку.
					let domEl = nodesById(domParent, nodeId(tplNode))[0];
					const slot = document.createElement('slot');
					const id = tplNode.getAttribute(ID_ATTR);
					slot.setAttribute(ID_ATTR, id);
					slot.setAttribute(PLACEHOLDER_ATTR, 1);
					domEl.replaceWith(slot);
				}
				domElsCnt--;
			}
		}
	}

	processAttrs(tplNode, domParent, index=0) {
		const domNode = nodesById(domParent, nodeId(tplNode))[index];
		const dynamicAttrs = Array.from(tplNode.attributes)
			.filter(attr => attr.name.startsWith(':'))
			.forEach(dynAttr => {
				const attrName = dynAttr.name.split(':')[1];
				const valExpr = dynAttr.value;
				const res = this.interpolate(valExpr);
				if (attrName == 'value') {
					if (domNode.__value != res) {
						domNode.value = res;
						domNode.__value = res;
					}
				} else if (attrName == 'text') {
					if (domNode.__value != res) {
						domNode.textContent = res;
						domNode.__value = res;
					}
				} else if (['checked', 'disabled', 'selected'].includes(attrName) &&
						['INPUT', 'BUTTON', 'OPTION'].includes(tplNode.nodeName)) {
					const isTrue = fixExprResult(res);
					domNode[attrName] = isTrue;
				} else {
					domNode.setAttribute(attrName, res);
				}
				domNode.removeAttribute(dynAttr.name);
			});
		if (tplNode.textContent.startsWith('{{')) {
			const tpl = tplNode.textContent.split('{{')[1].split('}}')[0];
			const res = this.interpolate(tpl);
			if (domNode.__value != res) {
				domNode.textContent = res;
				domNode.__value = res;
			}
		}
	}

	processEvents(tplNode, domParent) {
		const attrs = tplNode.getAttributeNames().filter(name => name.startsWith('@') && !RESERVED_ATTRS.includes(name));
		attrs.forEach(attr => {
			const evName = attr.split('@')[1];
			let methodnameTpl = tplNode.attributes[`@${evName}`].value;
			const domNode = nodesById(domParent, nodeId(tplNode))[0];
			let methodname = methodnameTpl;
			let args;
			if (methodnameTpl.includes('(')) {
				args = methodnameTpl.split('(')[1].split(')')[0];
				args = args.split(',').map(arg => this.context[arg.trim()]);
				methodname = methodnameTpl.split('(')[0];
			}
			if (evName == 'enter') evName = 'keypress';
			const wrapper = (args) => (ev) => {
				if (typeof this.c[methodname] != 'function') {
					console.warn('No method', methodname, 'in', this.c);
				}
				this.c[methodname](ev, ...args)
			};
			domNode.removeEventListener(evName, domNode.__mylistener);
			domNode.__mylistener = wrapper(args);
			domNode.addEventListener(evName, domNode.__mylistener);
		})
	}

	processComponentProps(cmp, tplNode, domParent) {
		if (!cmp.propsList) return;
		cmp.props = {};
		const propsList = cmp.propsList.map(p => p.toLowerCase());
		const domNode = nodesById(domParent, nodeId(tplNode))[0];
		const dynamicAttrs = Array.from(tplNode.attributes)
			.filter(attr => attr.name.startsWith(':'))
			.forEach(dynAttr => {
				const attrName = dynAttr.name.split(':')[1];
				const valName = dynAttr.value;
				if (cmp.propsList?.includes(attrName)) {
					if (this.context[valName]) {
						cmp.props[attrName] = this.context[valName];
					} else {
						const r = resolve(valName, this.c);
						if (r) {
							cmp.props[attrName] = resolve(valName, this.c);
						} else {
							const r = this.interpolate(valName);
							if (r) {
								cmp.props[attrName] = r;
							} else {
								cmp.props[attrName] = this.c[valName];
							}
						}
					}
				}
			})
	}

	interpolate(tpl) {

		const ctx = this.context;
		const state = {state: this.c.state};
		const props = {props: this.props};

		try {
			const func = new Function(
				...Object.keys(ctx),
				...Object.keys(state),
				...Object.keys(props),
				...instanceMethodNames(this.c),
				"return `"+tpl+"`;")
			let r = func(
				...Object.values(ctx),
				...Object.values(state),
				...Object.values(props),
				...instanceMethodsAsArray(this.c),
			);
			if (r == 'undefined') r = '';
			return r;
		} catch(e) {
			console.error('Cant interpolate', tpl, 'in', this, ':', e);
			return '';
		}
	}

	processRoutes(tplNode, domParent, domNode, reason='') {
		if (!this.c.routes || tplNode.nodeName != 'ROUTER-VIEW') return false;
		const route = findRoute(this.c.routes);
		domNode = nodesById(domParent, nodeId(tplNode))[0];
		if (!route) return;
		// Обработка ноды может выполняться неоднократно во время загрузки приложения.
		// Без этого компонент по роуту может создаваться несколько раз.
		if (domNode.__lastHref == location.href) {
			return
		}
		domNode.innerHTML = '';
		const cmp = new route.c();
		cmp.__route = route;
		cmp.$parent = this.c;
		cmp.rootNode = domNode;
		domNode.__cmp = cmp;
		domNode.__lastHref = location.href;
		domNode.setAttribute(CREATED_ATTR, '1');
		run(cmp);
	}

	onRouteChange() {
		this.processNodes(this.tpl, this.rootNode);
	}

	initRouter() {
		window.history.pushState = new Proxy(window.history.pushState, {
			apply: (target, thisArg, argArray) => {
				target.apply(thisArg, argArray);
				this.onHistoryChange();
				return target;
			},
		});
		window.addEventListener('popstate', (event) => {
			this.onHistoryBtnClick(event);
		});
	}

	onHistoryBtnClick(ev) { this.onRouteChange() }
	onHistoryChange(ev) { this.onRouteChange() }

	processRouteLinks(tplNode, domParent) {
		const domNode = nodesById(domParent, nodeId(tplNode))[0];
		if(tplNode.nodeName != 'A' || !domNode.attributes['to']) return false;
		// TODO: сделать более адекватную проверку на то, что event listener уже добавлен.
		if (domNode.getAttribute('href')) return;
		const url = domNode.attributes['to'].value;
		domNode.setAttribute('href', url);
		domNode.removeAttribute('to');
		domNode.addEventListener('click', (event) => {
			event.preventDefault();
			window.history.pushState({}, '', url);
		});
	}

}


function instanceMethodNames(instance) {
	const arrows = Object.getOwnPropertyNames(instance);
	const normal = Object.getOwnPropertyNames(instance.constructor.prototype);
	return arrows.concat(normal).filter(name => name != 'constructor');
}


function instanceMethodsAsArray(instance) {
	const names = instanceMethodNames(instance);
	return names.filter(name => name != 'constructor').map(name => instance[name])
}


window.__CUR_OBSERVERS = [];
export function observer(fn, name, isDeleted, dontWait=false) {
	let timeout;
	const c = {
		name: name,
		isDeleted: isDeleted,
	  	execute() {
			if (__CUR_OBSERVERS.indexOf(c) == -1) {
				__CUR_OBSERVERS.push(c);
			}
			if (dontWait) {
				const r = fn();
				const idx = __CUR_OBSERVERS.indexOf(c);
				__CUR_OBSERVERS.splice(idx, 1);
				return r;
			} else {
				window.cancelAnimationFrame(timeout);
				timeout = window.requestAnimationFrame(() => {
					fn();
					const idx = __CUR_OBSERVERS.indexOf(c);
					__CUR_OBSERVERS.splice(idx, 1);
				});
			}
		}
	}
	return c.execute();
};


export const computed = (fn) => reactive({}, fn);


export function reactive(v, computedFn=null) {
	if (v === null || ['number', 'string', 'boolean'].includes(typeof(v))) {
		return new Proxy({val: v}, makeHandler(computedFn));
	}
	return new Proxy(v, makeHandler(computedFn));
};
export const r = reactive;


const makeHandler = (computedFn=null) => {
	const subs = new Set();
	return {
		ownKeys(target) {
			return Reflect.ownKeys(target).filter(prop => prop != '__isProxy');
		},
		get(target, key, receiver) {
			if (computedFn) return computedFn();
			// С этим не подписывается на изменения state.some, если state.some изначально было пустым объектом.
			//if (key == '__isProxy') return true;
			const prop = target[key];
			if (typeof prop == 'undefined') return;

			if (typeof prop == 'object' && prop != null && !prop.__isProxy) {
				target[key] = new Proxy(prop, makeHandler(computedFn));
				target[key].__isProxy = true;
			}

			if (__CUR_OBSERVERS.length > 0) {
				__CUR_OBSERVERS.forEach(obs => {
					subs.add(obs);
				});
				for (const observer of subs) {
					if (observer.isDeleted && observer.isDeleted()) {
						subs.delete(observer);
					}
				}
			}
			return Reflect.get(...arguments)
		},
		set(target, key, value, receiver) {
			if (target[key] === value) return true;
			target[key] = value;
			for (const observer of subs) {
				if (observer.isDeleted && observer.isDeleted()) {
					subs.delete(observer);
				}  else {
					observer.execute();
				}
			}
			return true;
		},
		subs: subs
	}
}


export function _resolve(path, obj) {
	if (obj === undefined) obj = this;
	return path.split('.').reduce((p,c)=>p&&p[c], obj)
}


export function resolve(path, obj, runner=null) {
	if (obj === undefined) obj = this;
	if (runner && path.includes('[')) {
		const rawkey = path.split('[')[1].split(']')[0];
		const key = fixExprResult(runner.interpolate('${'+rawkey+'}'));
		if (key) path = path.split('[')[0] + '.' + key;
	}
	return path.split('.').reduce((p,c)=>p&&p[c], obj)
}


function fixExprResult(v) {
	if (v == 'false') return false;
	else if (v == 'true') return true;
	return v;
}


export function emit(node, name, detail) {
	const ev = new CustomEvent(name, {bubbles: true, detail: detail});
	node.dispatchEvent(ev);
}


export function nodeId(node) {
	return node.getAttribute(ID_ATTR);
}


export function nodesById(parent, nodeId) {
	return parent.querySelectorAll(`[${ID_ATTR}="${nodeId}"]`);
}


function findRoute(routes) {
	if (!routes) return null;
	const url = document.location.pathname.replace(/\/$/, '').toLowerCase();
	return Object.entries(routes).find(route => {
		route = route[1];
		const matcher = new RegExp(`${route.url}$`.replace(/:[^\s/]+/g, '([\\w-]+)'));
		const match = url.match(matcher);
		if (match) {
			route.match = match;
			return true;
		}
	})?.[1];
}
