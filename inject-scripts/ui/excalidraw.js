(() => {
    const SCRIPT_ID = 'excalidraw-control-script';
    if (window[SCRIPT_ID]) {
        return;
    }

    // Helper function for sleep
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Core API extraction function (from recommend.txt)
    function getExcalidrawAPIFromDOM(domElement) {
        if (!domElement) { return null; }
        const reactFiberKey = Object.keys(domElement).find((key) => 
            key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
        );
        if (!reactFiberKey) { return null; }
        let fiberNode = domElement[reactFiberKey];
        if (!fiberNode) { return null; }

        function isExcalidrawAPI(obj) {
            return (
                typeof obj === 'object' &&
                obj !== null &&
                typeof obj.updateScene === 'function' &&
                typeof obj.getSceneElements === 'function' &&
                typeof obj.getAppState === 'function'
            );
        }

        function findApiInObject(objToSearch) {
            if (isExcalidrawAPI(objToSearch)) {
                return objToSearch;
            }
            if (typeof objToSearch === 'object' && objToSearch !== null) {
                for (const key in objToSearch) {
                    if (Object.prototype.hasOwnProperty.call(objToSearch, key)) {
                        const found = findApiInObject(objToSearch[key]);
                        if (found) {
                            return found;
                        }
                    }
                }
            }
            return null;
        }

        let excalidrawApiInstance = null;
        let attempts = 0;
        const MAX_TRAVERSAL_ATTEMPTS = 25;

        while (fiberNode && attempts < MAX_TRAVERSAL_ATTEMPTS) {
            if (fiberNode.stateNode && fiberNode.stateNode.props) {
                const api = findApiInObject(fiberNode.stateNode.props);
                if (api) {
                    excalidrawApiInstance = api;
                    break;
                }
                if (isExcalidrawAPI(fiberNode.stateNode.props.excalidrawAPI)) {
                    excalidrawApiInstance = fiberNode.stateNode.props.excalidrawAPI;
                    break;
                }
            }

            if (fiberNode.memoizedProps) {
                const api = findApiInObject(fiberNode.memoizedProps);
                if (api) {
                    excalidrawApiInstance = api;
                    break;
                }
                if (isExcalidrawAPI(fiberNode.memoizedProps.excalidrawAPI)) {
                    excalidrawApiInstance = fiberNode.memoizedProps.excalidrawAPI;
                    break;
                }
            }

            if (fiberNode.tag === 1 && fiberNode.stateNode && fiberNode.stateNode.state) {
                const api = findApiInObject(fiberNode.stateNode.state);
                if (api) {
                    excalidrawApiInstance = api;
                    break;
                }
            }

            if (fiberNode.tag === 0 || fiberNode.tag === 2 || fiberNode.tag === 14 || fiberNode.tag === 15 || fiberNode.tag === 11) {
                if (fiberNode.memoizedState) {
                    let currentHook = fiberNode.memoizedState;
                    let hookAttempts = 0;
                    const MAX_HOOK_ATTEMPTS = 15;
                    while (currentHook && hookAttempts < MAX_HOOK_ATTEMPTS) {
                        const api = findApiInObject(currentHook.memoizedState);
                        if (api) {
                            excalidrawApiInstance = api;
                            break;
                        }
                        currentHook = currentHook.next;
                        hookAttempts++;
                    }
                    if (excalidrawApiInstance) break;
                }
            }

            if (fiberNode.stateNode) {
                const api = findApiInObject(fiberNode.stateNode);
                if (api && api !== fiberNode.stateNode.props && api !== fiberNode.stateNode.state) {
                    excalidrawApiInstance = api;
                    break;
                }
            }

            if (fiberNode.tag === 9 && fiberNode.memoizedProps && typeof fiberNode.memoizedProps.value !== 'undefined') {
                const api = findApiInObject(fiberNode.memoizedProps.value);
                if (api) {
                    excalidrawApiInstance = api;
                    break;
                }
            }

            if (fiberNode.return) {
                fiberNode = fiberNode.return;
            } else {
                break;
            }
            attempts++;
        }

        if (excalidrawApiInstance) {
            window.excalidrawAPI = excalidrawApiInstance;
            console.log('Excalidraw API found and available at window.excalidrawAPI');
        } else {
            console.error('Failed to find excalidrawAPI after checking component tree.');
        }
        return excalidrawApiInstance;
    }

    // Measure text width/height using canvas for accurate centering
    function measureTextSize(text = '', fontSize = 20, fontFamily = 1, lineHeight = 1.25) {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            // Map excalidraw fontFamily index to a real font stack (approximation)
            const family = (fontFamily === 2 ? 'Helvetica, Arial, sans-serif' : fontFamily === 3 ? 'Cascadia, Consolas, monospace' : 'Virgil, Segoe UI, Helvetica, Arial, sans-serif');
            ctx.font = `${fontSize}px ${family}`;
            const lines = String(text).split(/\n/);
            let maxWidth = 0;
            for (const line of lines) {
                const w = ctx.measureText(line).width;
                if (w > maxWidth) maxWidth = w;
            }
            const height = Math.max(fontSize, Math.ceil(lines.length * fontSize * lineHeight));
            return { width: Math.ceil(maxWidth), height };
        } catch (_e) {
            // Fallback estimation
            const estWidth = Math.ceil(String(text).length * fontSize * 0.6);
            const estHeight = Math.ceil(fontSize * lineHeight);
            return { width: estWidth, height: estHeight };
        }
    }

    // Enhanced element creation function (from recommend.txt)
    function createFullExcalidrawElement(skeleton) {
        const id = skeleton.id || Math.random().toString(36).substring(2, 9);
        const seed = Math.floor(Math.random() * 2 ** 31);
        const versionNonce = Math.floor(Math.random() * 2 ** 31);
        
        const defaults = {
            isDeleted: false,
            fillStyle: 'hachure',
            strokeWidth: 1,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            angle: 0,
            groupIds: [],
            strokeColor: '#000000',
            backgroundColor: 'transparent',
            version: 1,
            locked: false
        };
        
        let extraDefaults = {};
        if (skeleton.type === 'text') {
            extraDefaults = {
                fontSize: 20,
                fontFamily: 1,
                textAlign: 'center',
                verticalAlign: 'middle',
                originText: skeleton.text,
                originalText: skeleton.text,
                autoResize: true,
                lineHeight: 1.25
            };
        } else if (skeleton.type === 'arrow') {
            extraDefaults = { 
                points: skeleton.points || [[0, 0], [100, 0]] 
            };
        }
        
        return { 
            ...defaults, 
            ...extraDefaults, 
            ...skeleton, 
            id, 
            seed, 
            versionNonce, 
            updated: Date.now() 
        };
    }

    // Initialize API
    let targetElementForAPI = document.querySelector('.excalidraw-app');
    if (targetElementForAPI) {
        getExcalidrawAPIFromDOM(targetElementForAPI);
    }

    // Enhanced event handlers with text binding and arrow connection support
    const eventHandler = {
        getSceneElements: () => {
            try {
                return window.excalidrawAPI.getSceneElements();
            } catch (error) {
                return { error: JSON.stringify(error) };
            }
        },

        addElement: async (param) => {
            try {
                const eles = (param && Array.isArray(param.eles)) ? param.eles : [];
                if (!eles.length) {
                    return { error: 'addElement: payload.eles must be a non-empty array' };
                }

                const existingElements = window.excalidrawAPI.getSceneElements();
                const newElements = [...existingElements];
                const createdElements = [];

                // Normalize and create elements
                const normalize = (ele) => {
                    const e = { ...ele };
                    if (!e.type) {
                        throw new Error('addElement: element.type is required');
                    }
                    if (typeof e.x !== 'number') e.x = 0;
                    if (typeof e.y !== 'number') e.y = 0;

                    const t = e.type;
                    if (t === 'text') {
                        if (typeof e.text !== 'string') e.text = '';
                        // 规范化换行：模型有时会把换行输出为字面 "\n"（反斜杠 + n
                        // 两个字符），Excalidraw 会原样渲染导致不换行。
                        // 统一替换为真实换行符（\r\n / \r / \n 字面量全兼容）
                        const normalizedText = e.text
                            .replace(/\\r\\n/g, '\n')
                            .replace(/\\n/g, '\n')
                            .replace(/\\r/g, '\n');
                        e.text = normalizedText;
                        // originText（旧字段名）/ originalText（0.17+ 字段名）双写，
                        // 覆盖不同版本 Excalidraw 对正文字段的读取口径
                        e.originText = normalizedText;
                        e.originalText = normalizedText;
                        if (typeof e.fontSize !== 'number') e.fontSize = 20;
                        if (typeof e.fontFamily !== 'number') e.fontFamily = 1;
                        if (typeof e.textAlign !== 'string') e.textAlign = 'center';
                        if (typeof e.verticalAlign !== 'string') e.verticalAlign = 'middle';
                        if (e.autoResize === undefined) e.autoResize = true;
                        if (typeof e.lineHeight !== 'number') e.lineHeight = 1.25;
                        if (typeof e.width !== 'number') {
                            const size = measureTextSize(e.text, e.fontSize, e.fontFamily, e.lineHeight);
                            e.width = Math.max(10, size.width);
                        }
                        if (typeof e.height !== 'number') {
                            const size = measureTextSize(e.text, e.fontSize, e.fontFamily, e.lineHeight);
                            e.height = Math.max(10, size.height);
                        }
                    } else if (t === 'arrow' || t === 'line') {
                        if (!Array.isArray(e.points) || e.points.length < 2) {
                            const w = (typeof e.width === 'number' && e.width > 0) ? e.width : 100;
                            const h = (typeof e.height === 'number' && e.height > 0) ? e.height : 0;
                            e.points = [[0, 0], [w, h]];
                        }
                        if (typeof e.endArrowhead === 'undefined' && t === 'arrow') {
                            e.endArrowhead = 'arrow';
                        }
                        if (typeof e.width !== 'number' || typeof e.height !== 'number') {
                            const p0 = e.points[0], p1 = e.points[e.points.length - 1];
                            e.width = Math.abs(p1[0] - p0[0]);
                            e.height = Math.abs(p1[1] - p0[1]);
                        }
                    } else {
                        if (typeof e.width !== 'number' || e.width <= 0) e.width = 150;
                        if (typeof e.height !== 'number' || e.height <= 0) e.height = 60;
                    }

                    if (typeof e.strokeColor !== 'string') e.strokeColor = '#000000';
                    if (typeof e.backgroundColor !== 'string') e.backgroundColor = 'transparent';
                    if (typeof e.fillStyle !== 'string') e.fillStyle = 'hachure';
                    if (typeof e.strokeWidth !== 'number') e.strokeWidth = 1;
                    if (typeof e.strokeStyle !== 'string') e.strokeStyle = 'solid';
                    if (typeof e.roughness !== 'number') e.roughness = 1;
                    if (typeof e.opacity !== 'number') e.opacity = 100;
                    if (!Array.isArray(e.groupIds)) e.groupIds = [];
                    if (typeof e.angle !== 'number') e.angle = 0;
                    return e;
                };

                // Helpers for binding detection
                const getBindingIds = (arrow) => {
                    const mapId = (v) => (typeof v === 'string' ? v : (v && v.elementId) ? v.elementId : undefined);
                    const startId = mapId(arrow.startBinding) || arrow.fromId || arrow.from || arrow.sourceId || arrow.startId;
                    const endId = mapId(arrow.endBinding) || arrow.toId || arrow.to || arrow.targetId || arrow.endId;
                    return { startId, endId };
                };

                // 📝 DETECT TEXT-CONTAINER RELATIONSHIPS
                // Group text elements with their potential containers
                const textContainerPairs = [];
                const arrowBindings = [];
                
                eles.forEach((ele) => {
                    const normalized = normalize(ele);
                    
                    // Detect text-container relationships by ID pattern or explicit containerId
                    if (normalized.type === 'text') {
                        let potentialContainerId = normalized.containerId;
                        if (!potentialContainerId && typeof normalized.id === 'string' && normalized.id.endsWith('-text')) {
                            potentialContainerId = normalized.id.replace(/-text$/, '');
                        }
                        if (potentialContainerId) {
                            const containerCandidate = eles.find(e => e.id === potentialContainerId && e.type !== 'text');
                            if (containerCandidate) {
                                textContainerPairs.push({
                                    text: normalized,
                                    containerId: potentialContainerId
                                });
                            }
                        }
                    }
                    
                    // Detect arrow binding requirements with aliases
                    if (normalized.type === 'arrow' || normalized.type === 'line') {
                        const { startId, endId } = getBindingIds(normalized);
                        // Always push so we can run fallback inference when IDs are missing
                        arrowBindings.push({ ...normalized, __startId: startId, __endId: endId });
                    }
                });

                // Create all elements first
                eles.forEach((ele) => {
                    const normalized = normalize(ele);
                    const newEle = createFullExcalidrawElement(normalized);
                    newElements.push(newEle);
                    createdElements.push(newEle);
                });

                // Update scene with new elements
                const appState = window.excalidrawAPI.getAppState();
                window.excalidrawAPI.updateScene({
                    elements: newElements,
                    appState,
                    commitToHistory: true
                });

                // Wait for elements to be rendered
                await sleep(180);

                // 🎯 ENHANCED TEXT CENTERING & CONTAINER BINDING
                const liveElements = window.excalidrawAPI.getSceneElements();
                
                // Helper: dedupe bound elements
                const addBound = (el, item) => {
                    const list = [...(el.boundElements || [])];
                    if (!list.some(b => b.id === item.id && b.type === item.type)) {
                        list.push(item);
                        window.excalidrawAPI.mutateElement(el, { boundElements: list });
                    }
                };

                for (const pair of textContainerPairs) {
                    const container = liveElements.find(el => el.id === pair.containerId);
                    const textEl = liveElements.find(el => el.id === pair.text.id);
                    
                    if (container && textEl) {
                        // Recalculate text intrinsic size for accurate centering
                        const size = measureTextSize(textEl.text || textEl.originText || '', textEl.fontSize || 20, textEl.fontFamily || 1, textEl.lineHeight || 1.25);
                        const w = Math.max(10, size.width);
                        const h = Math.max(10, size.height);
                        window.excalidrawAPI.mutateElement(textEl, { width: w, height: h, textAlign: 'center', verticalAlign: 'middle' });

                        // Establish bi-directional binding
                        window.excalidrawAPI.mutateElement(textEl, { containerId: container.id });
                        addBound(container, { type: 'text', id: textEl.id });
                        
                        // ✨ CRITICAL: Calculate exact center position using measured size
                        const containerCenterX = container.x + (container.width / 2);
                        const containerCenterY = container.y + (container.height / 2);
                        const textCenterX = containerCenterX - (w / 2);
                        const textCenterY = containerCenterY - (h / 2);
                        
                        // Update text position to be perfectly centered
                        window.excalidrawAPI.mutateElement(textEl, { 
                            x: textCenterX, 
                            y: textCenterY 
                        });
                        
                        console.log(`Text "${textEl.text}" centered in container "${container.id}": (${textCenterX}, ${textCenterY})`);
                    }
                }

                // 🎯 ENHANCED ARROW BINDING WITH SMART CONNECTION POINTS
                const resolveTargetId = (id) => {
                    if (!id) return undefined;
                    const el = liveElements.find(e => e.id === id);
                    if (!el) {
                        // try map text id suffix
                        if (/-text$/.test(id)) {
                            const cid = id.replace(/-text$/, '');
                            return liveElements.find(e => e.id === cid) ? cid : id;
                        }
                        return id;
                    }
                    if (el.type === 'text') {
                        if (el.containerId) return el.containerId;
                        if (/-text$/.test(id)) {
                            const cid = id.replace(/-text$/, '');
                            return liveElements.find(e => e.id === cid) ? cid : id;
                        }
                    }
                    return id;
                };

                const findNearestElementByPoint = (px, py) => {
                    let best = null;
                    let bestDist = Infinity;
                    for (const el of liveElements) {
                        if (!el || el.isDeleted) continue;
                        if (el.type === 'text' || el.type === 'arrow' || el.type === 'line') continue;
                        const cx = el.x + el.width / 2;
                        const cy = el.y + el.height / 2;
                        const dx = cx - px;
                        const dy = cy - py;
                        const dist = Math.hypot(dx, dy);
                        if (dist < bestDist) {
                            bestDist = dist;
                            best = el;
                        }
                    }
                    return best;
                };

                for (const arrowConfig of arrowBindings) {
                    const liveArrow = liveElements.find(el => el.id === arrowConfig.id);
                    if (!liveArrow) continue;
                    
                    const updates = {};
                    let startEl = null, endEl = null;

                    // Resolve start/end element ids with alias support and text->container mapping
                    const startId = resolveTargetId(arrowConfig.__startId);
                    const endId = resolveTargetId(arrowConfig.__endId);

                    if (startId) {
                        startEl = liveElements.find(el => el.id === startId);
                        if (startEl) {
                            updates.startBinding = { elementId: startEl.id };
                        }
                    }
                    if (endId) {
                        endEl = liveElements.find(el => el.id === endId);
                        if (endEl) {
                            updates.endBinding = { elementId: endEl.id };
                        }
                    }

                    // Fallback: infer from current arrow geometry if binding missing
                    if (!startEl || !endEl) {
                        const p0 = Array.isArray(liveArrow.points) && liveArrow.points[0] ? liveArrow.points[0] : [0, 0];
                        const p1 = Array.isArray(liveArrow.points) && liveArrow.points[liveArrow.points.length - 1] ? liveArrow.points[liveArrow.points.length - 1] : [liveArrow.width || 0, liveArrow.height || 0];
                        const absStartX = (typeof liveArrow.x === 'number' ? liveArrow.x : 0) + p0[0];
                        const absStartY = (typeof liveArrow.y === 'number' ? liveArrow.y : 0) + p0[1];
                        const absEndX = (typeof liveArrow.x === 'number' ? liveArrow.x : 0) + p1[0];
                        const absEndY = (typeof liveArrow.y === 'number' ? liveArrow.y : 0) + p1[1];
                        if (!startEl) {
                            startEl = findNearestElementByPoint(absStartX, absStartY);
                            if (startEl) updates.startBinding = { elementId: startEl.id };
                        }
                        if (!endEl) {
                            endEl = findNearestElementByPoint(absEndX, absEndY);
                            if (endEl) updates.endBinding = { elementId: endEl.id };
                        }
                    }
                    
                    // 📐 Calculate smart connection points and arrow positioning
                    if (startEl && endEl) {
                        const startCenterX = startEl.x + (startEl.width / 2);
                        const startCenterY = startEl.y + (startEl.height / 2);
                        const endCenterX = endEl.x + (endEl.width / 2);
                        const endCenterY = endEl.y + (endEl.height / 2);
                        
                        // Calculate connection points on element edges
                        const deltaX = endCenterX - startCenterX;
                        const deltaY = endCenterY - startCenterY;
                        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                        
                        if (distance > 0) {
                            const unitX = deltaX / distance;
                            const unitY = deltaY / distance;
                            const margin = 4; // keep a small gap from the border
                            
                            // Radii/half-sizes
                            const startRadiusX = startEl.width / 2;
                            const startRadiusY = startEl.height / 2;
                            const endRadiusX = endEl.width / 2;
                            const endRadiusY = endEl.height / 2;
                            
                            // For rectangles/ellipses, find intersection with border
                            let startOffsetX, startOffsetY, endOffsetX, endOffsetY;
                            
                            if (startEl.type === 'ellipse') {
                                const t = Math.atan2(unitY * startRadiusX, unitX * startRadiusY);
                                startOffsetX = startRadiusX * Math.cos(t);
                                startOffsetY = startRadiusY * Math.sin(t);
                            } else {
                                // Rectangle
                                const ratioX = Math.abs(unitX) > 0 ? startRadiusX / Math.abs(unitX) : Infinity;
                                const ratioY = Math.abs(unitY) > 0 ? startRadiusY / Math.abs(unitY) : Infinity;
                                const ratio = Math.min(ratioX, ratioY);
                                startOffsetX = unitX * ratio;
                                startOffsetY = unitY * ratio;
                            }
                            
                            if (endEl.type === 'ellipse') {
                                const t = Math.atan2(-unitY * endRadiusX, -unitX * endRadiusY);
                                endOffsetX = endRadiusX * Math.cos(t);
                                endOffsetY = endRadiusY * Math.sin(t);
                            } else {
                                // Rectangle
                                const ratioX = Math.abs(unitX) > 0 ? endRadiusX / Math.abs(unitX) : Infinity;
                                const ratioY = Math.abs(unitY) > 0 ? endRadiusY / Math.abs(unitY) : Infinity;
                                const ratio = Math.min(ratioX, ratioY);
                                endOffsetX = -unitX * ratio;
                                endOffsetY = -unitY * ratio;
                            }
                            
                            // Apply margin gap
                            const arrowStartX = startCenterX + startOffsetX + unitX * margin;
                            const arrowStartY = startCenterY + startOffsetY + unitY * margin;
                            const arrowEndX = endCenterX + endOffsetX - unitX * margin;
                            const arrowEndY = endCenterY + endOffsetY - unitY * margin;
                            
                            // Update arrow position and points
                            updates.x = arrowStartX;
                            updates.y = arrowStartY;
                            updates.width = Math.abs(arrowEndX - arrowStartX);
                            updates.height = Math.abs(arrowEndY - arrowStartY);
                            updates.points = [[0, 0], [arrowEndX - arrowStartX, arrowEndY - arrowStartY]];
                            
                            console.log(`Arrow "${liveArrow.id}" positioned from (${arrowStartX.toFixed(1)}, ${arrowStartY.toFixed(1)}) to (${arrowEndX.toFixed(1)}, ${arrowEndY.toFixed(1)})`);
                        }
                        
                        // Update bound elements (dedup)
                        addBound(startEl, { type: 'arrow', id: liveArrow.id });
                        addBound(endEl, { type: 'arrow', id: liveArrow.id });
                    }
                    
                    // Apply all updates to the arrow
                    if (Object.keys(updates).length > 0) {
                        window.excalidrawAPI.mutateElement(liveArrow, updates);
                    }
                }

                // Final refresh to ensure all changes are applied
                await sleep(60);

                return { data: { success: true } };
            } catch (error) {
                return { error: (error && error.message) ? error.message : String(error) };
            }
        },

        deleteElement: (param) => {
            try {
                const existingElements = window.excalidrawAPI.getSceneElements();
                const newElements = [...existingElements];
                const idx = newElements.findIndex((e) => e.id === param.id);
                if (idx >= 0) {
                    newElements.splice(idx, 1);
                    const appState = window.excalidrawAPI.getAppState();
                    window.excalidrawAPI.updateScene({
                        elements: newElements,
                        appState: appState,
                        commitToHistory: true
                    });
                    return { data: { success: true } };
                } else {
                    return { error: 'element not found' };
                }
            } catch (error) {
                return { error: JSON.stringify(error) };
            }
        },

        updateElement: (param) => {
            try {
                const existingElements = window.excalidrawAPI.getSceneElements();
                const resIds = [];
                for (let i = 0; i < param.length; i++) {
                    const idx = existingElements.findIndex((e) => e.id === param[i].id);
                    if (idx >= 0) {
                        resIds.push(param[i].id);
                        window.excalidrawAPI.mutateElement(existingElements[idx], { ...param[i] });
                    }
                }
                return { data: { success: true, msg: `Updated elements: ${resIds.join(',')}` } };
            } catch (error) {
                return { error: JSON.stringify(error) };
            }
        },

        cleanup: () => {
            try {
                window.excalidrawAPI.resetScene();
                return { data: { success: true } };
            } catch (error) {
                return { error: JSON.stringify(error) };
            }
        }
    };

    // Event handling
    const handleExecution = async (event) => {
        const { action, payload, requestId } = event.detail;
        const param = JSON.parse(payload || '{}');

        if (!window.excalidrawAPI) {
            try {
                const appEl = document.querySelector('.excalidraw-app');
                if (appEl) {
                    getExcalidrawAPIFromDOM(appEl);
                }
            } catch (_e) {
                // ignore
            }
        }

        let resp;
        try {
            const handler = eventHandler[action];
            if (!handler) {
                resp = { error: 'event name not found' };
            } else {
                resp = await handler(param);
            }
        } catch (e) {
            resp = { error: e && e.message ? e.message : String(e) };
        }

        // Normalize to { data, error }
        const data = resp && resp.data !== undefined ? resp.data : (resp && !resp.error ? resp : undefined);
        const error = resp && resp.error ? resp.error : undefined;

        window.dispatchEvent(new CustomEvent('chrome-mcp:response', {
            detail: { requestId, data, error }
        }));
    };

    const initialize = () => {
        window.addEventListener('chrome-mcp:execute', handleExecution);
        window.addEventListener('chrome-mcp:cleanup', cleanup);
        window[SCRIPT_ID] = true;
    };

    function cleanup() {
        window.removeEventListener('chrome-mcp:execute', handleExecution);
        window.removeEventListener('chrome-mcp:cleanup', cleanup);
        delete window[SCRIPT_ID];
        delete window.excalidrawAPI;
    }

    initialize();
})();