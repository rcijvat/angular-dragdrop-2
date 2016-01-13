// Module enables easy drag and drop of multiple HTML elements.

// Some important notes:
// - drag-container should have the drag-element directives as direct offspring, since otherwise we do not
//   know where to append drag-element directives when drag-container is empty
// - All events captured here are captures with the angular.element.bind method. Handling such events goes outside of
//   the Angular digest. Since we always do this, we know that we will always have to call $rootScope.$apply after
//   we change some of the data provided to us.


// Instead of having to supply callback functions to the directives of this module, events will be emitted on the rootscope,
// using $emit. This means, that any listeners should listen to the rootscope using $rootScope.$on
// Below is a list of all events that can occur. Below every event, there is a description of the event object that gets passed
// to the event handler when the event happens.
// - dragdrop:dragStart (whenever drag starts)
//   * type                  [string] The type of the drag operation, as passed to the directives that make up this drag
//
// - dragdrop:dragEnd (whenever drag ends)
//   * type                  [string] The type of the drag operation, as passed to the directives that make up this drag
//
// - dragdrop:elementMoved (whenever an element gets dragged from one position to another; not triggered if element gets
//                          dragged to the position it started)
//   * type                  [string] The type of the drag operation, as passed to the directives that make up this drag
//   * elementData           [any]    The data that was passed to the dragElement directive
//   * fromContainerData     [any]    The data that was passed to the container where the element started
//   * fromContainerIndex    [int]    The initial index of the element in the fromContainer
//   * toContainerData       [any]    The data that was passed to the container where the element ended up
//   * toContainerIndex      [int]    The new index of the element in its new container

angular.module("dragdrop", [])

    // define a provider that can be used to change default behavior of the dragdrop module

    // This is how you can configure drag drop from your module:
    //
    //angular.module("yourmodule", ["dragdrop"])
    //
    //  .config(["dragdropConfigProvider", function(dragdropConfigProvider) {
    //      dragdropConfigProvider.options({
    //          horizontal: false
    //      });
    //  }]);

    .provider("dragdropConfig", function() {
        var defaultOptions = {
            horizontal: false
        };

        var globalOptions = {};

        this.options = function(opts) {
            angular.extend(globalOptions, opts);
        };

        this.$get = function() {
            return angular.extend({}, defaultOptions, globalOptions);
        };
    })

    // Defines constructor for Drag object, which manages all drag related things for a specific drag type
    .factory("Drag", ["$rootScope", "$window", "$document", "$timeout", "dragdropConfig",
            function($rootScope, $window, $document, $timeout, dragdropConfig) {
        function docRelPos(clientCoords) {
            return [clientCoords[0] + $window.scrollX, clientCoords[1] + $window.scrollY];
        }

        function rect(elem) {
            var r = elem[0].getBoundingClientRect();
            var p = docRelPos([r.left, r.top]);
            return {
                left: p[0],
                top: p[1],
                width: r.width,
                height: r.height
            };
        }

        function register(arr, elem) {
            arr.push(elem);
            return function() {
                _.remove(arr, elem);
            };
        }

        function containsX(r, point) {
            return point[0] >= r.left && point[0] <= r.left + r.width;
        }

        function containsY(r, point) {
            return point[1] >= r.top && point[1] <= r.top + r.height;
        }

        function contains(elem, point) {
            var r = rect(elem);
            return containsX(r, point) && containsY(r, point);
        }

        function closest(r1, r2, p) {
            return _.min([
                Math.abs(p - r1),
                Math.abs(p - r2)
            ]);
        }

        // The distance between an element and a point is defined as the smallest manhattan distance to
        // one of the edges of the bounding rect, with a minimum of 0.
        // We use the following logic:
        // - We compute the distance separately for x and y
        // - If a coordinate lies within the bounding rect, the distance for this dimension is 0
        // - Otherwise, the distance is the minimum distance between the point and both edges in this dimension.
        // - The total distance is the sum of the distance for X and Y
        function distance(elem, point) {
            var r = rect(elem);
            var distX = containsX(r, point) ? 0 : closest(r.left, r.left + r.width , point[0]);
            var distY = containsY(r, point) ? 0 : closest(r.top,  r.top  + r.height, point[1]);
            return distX + distY;
        }


        // Takes Angular element and returns next Angular element with the attribute drag-element or data-drag-element set

        function nextDragElement(dragElem) {
            var next = angular.element(dragElem[0].nextSibling);
            while(next[0] && !next.hasClass("drag-element")) {
                next = angular.element(next[0].nextSibling);
            }
            return _.isEmpty(next) ? [null] : next;
        }

        function Drag(type) {
            var self = this;

            // private vars
            var _type = type;
            var _dragging = false;
            var _dragElement = null; // Instance of Drag.Element; the currently dragged element
            var _dragElem = null; // Angular element, clone of _dragElement.elem; used for dragging around
            var _mousePos = null; // mouse position relative to the top left corner of the drag element

            // private ghost vars
            var _ghostContainer = null; // Drag.Container instance; the container containing the ghost element
            var _ghost = null; // Angular element

            // private origin vars
            var _sourceContainer = null;
            var _sourceContainerIndex = 0;


            // private functions
            var _createGhost = function(elem) {
                return angular.element(elem[0].cloneNode(false))
                    .css("position", null)
                    .css("top", null)
                    .css("left", null)
                    .css("right", null)
                    .css("bottom", null)
                    .css("border", "3px dashed #666")
                    .addClass("ghost");
            };

            var _removeGhost = function() {
                if(_ghost) {
                    _ghost.remove();
                    _ghost = null;
                }
            };

            var _getElementIndex = function(dragContainer, elem) {
                var i = 0;
                var prev = angular.element(elem[0].previousSibling);
                while(!_.isEmpty(prev)) {
                    if(prev.hasClass("drag-element")) {
                        ++i;
                    }
                    prev = angular.element(prev[0].previousSibling);
                }
                return i;
            };

            var _removeElemFromContainer = function(dragContainer, dragElement) {
                _.remove(dragContainer.data, dragElement.data);
                $rootScope.$apply();
            };

            var _addElemToContainer = function(dragContainer, dragElement, index) {
                // First we will have to figure out the index
                // We do this by starting at the ghost element, and walk back until the first element of the container
                // using previousSibling, counting all .drag-element elements along the way
                dragContainer.data.splice(index, 0, dragElement.data);
                $rootScope.$apply();
            };


            // public attributes
            self.backgrounds = [];
            self.containers = [];
            self.elements = [];


            // public methods
            self.mouse = Drag.mouse;

            // dragBackground should be instance of Drag.Background
            self.registerBackground = function(dragBackground) {
                return register(self.backgrounds, dragBackground);
            };

            // dragContainer should be instance of Drag.Container
            self.registerContainer = function(dragContainer) {
                return register(self.containers, dragContainer);
            };

            // dragElement should be instance of Drag.Element
            self.registerElement = function(dragElement) {
                return register(self.elements, dragElement);
            };

            self.dragging = function() {
                return _dragging;
            };


            self.start = function(startCoordsMouse, dragContainer, dragElement) {
                if(_dragging) return;
                $rootScope.$emit("dragdrop:dragStart", {type: _type});

                // start with setting some source info
                _sourceContainer = dragContainer;
                _sourceContainerIndex = _.findIndex(_sourceContainer.data, dragElement.data);

                _dragElement = dragElement;
                _dragElem = angular.element(_dragElement.elem[0].cloneNode(true));

                var r = rect(_dragElement.elem);
                _mousePos = [r.left - startCoordsMouse[0], r.top - startCoordsMouse[1]];
                _dragElem.css({
                    position: "absolute",
                    left: r.left + "px",
                    top: r.top + "px",
                    width: r.width + "px",
                    height: r.height + "px",
                    opacity: .7
                });
                angular.element($document[0].body).append(_dragElem);

                // We have the clone appended to the body; now create a ghost element and insert it in the dom, right
                // before the current dragElem
                _ghost = _createGhost(_dragElem);
                _ghostContainer = dragContainer;
                dragContainer.elem[0].insertBefore(_ghost[0], _dragElement.elem[0]);

                // Now we can safely remove the drag element from the drag container
                _removeElemFromContainer(dragContainer, _dragElement);

                _dragging = true;
            };

            self.drag = function(mouseCoords) {
                if(!_dragging) return;
                // Replace dragged element according to mouse cursor
                _dragElem.css({
                    left: mouseCoords[0] + _mousePos[0] + "px",
                    top: mouseCoords[1] + _mousePos[1] + "px"
                });

                // See if there is a container on the current mouse position
                var hoverContainer = _.find(self.containers, function(c) {
                    return contains(c.elem, mouseCoords);
                });

                if(hoverContainer) {
                    // The mouse is currently on a container.
                    _ghostContainer = hoverContainer;
                    // Get the element in this container with the smallest distance to the mouse
                    var closestElt = _(self.elements).filter(function(el) {
                        // only include elements inside the mouseover container
                        return hoverContainer.elem[0].contains(el.elem[0]);
                    }).min(function(elt) {
                        // return container with minimum distance
                        return distance(elt.elem, mouseCoords);
                    });

                    var elemAfterGhost = null;
                    if(_.isObject(closestElt)) {
                        // We have to determine whether we have to place the ghost before or after the closest elt.

                        // Either way, we will need the bounding rect of the closest elt
                        var r = rect(closestElt.elem);

                        // We need the horizontal option, since we want to know whether we have to look at
                        // either the x or the y dimension.
                        var midway;
                        if(hoverContainer.horizontal) {
                            // check x dimension
                            midway = r.left + r.width / 2;
                            elemAfterGhost = mouseCoords[0] < midway ?
                                closestElt.elem :
                                nextDragElement(closestElt.elem);
                        } else {
                            // check y dimension
                            midway = r.top + r.height / 2;
                            elemAfterGhost = mouseCoords[1] < midway ?
                                closestElt.elem :
                                nextDragElement(closestElt.elem);
                        }
                        // Use insertbefore to insert the ghost at the appropriate position.
                        // Note: When elemAfterGhost turns out to be null (can be the case when nextSibling returned
                        //       null), insertBefore will just insert at the end
                        hoverContainer.elem[0].insertBefore(_ghost[0], elemAfterGhost[0]);
                    } else {
                        hoverContainer.elem.append(_ghost);
                    }

                }
            };

            self.end = function() {
                if(!_dragging) return;
                _dragElem.remove();
                var i = _getElementIndex(_ghostContainer, _ghost);
                _addElemToContainer(_ghostContainer, _dragElement, i);

                $timeout(function() {
                    _removeGhost();

                    // emit event if something changed during this drag
                    if(_sourceContainer !== _ghostContainer || _sourceContainerIndex !== i) {
                        $rootScope.$emit("dragdrop:elementMoved", {
                            type: _type,
                            elementData: _dragElement.data,
                            fromContainerData: _sourceContainer.data,
                            fromContainerIndex: _sourceContainerIndex,
                            toContainerData: _ghostContainer.data,
                            toContainerIndex: i
                        });
                    }
                }, 0);

                _dragging = false;
                $rootScope.$emit("dragdrop:dragEnd", {type: _type});
            };
        }

        Drag.mouse = function(event) {
            if(!("pageX" in event) || !("pageY" in event)) {
                return docRelPos([event.clientX, event.clientY]);
            }
            return [event.pageX, event.pageY];
        };

        Drag.Background = function(elem) {
            this.elem = elem;
        };

        Drag.Container = function(elem, data, horizontal) {
            this.elem = elem;
            this.data = data;
            this.horizontal = _.isBoolean(horizontal) ? horizontal : dragdropConfig.horizontal;
        };

        Drag.Element = function(elem, data) {
            this.elem = elem;
            this.data = data;
        };

        return Drag;
    }])

    .factory("dragStore", ["$document", "Drag", function($document, Drag) {
        var dragObjs = {};
        var drag = null; // Contains Drag object of currently dragged element when dragging

        var dragStore = function(type) {
            if(!arguments.length) {
                return drag; // either null or the active drag object
            }
            var d = dragObjs[type];
            if(!d) {
                d = new Drag(type);
                dragObjs[type] = d;
            }
            return d;
        };

        dragStore.start = function(startCoordsMouse, dragContainer, dragElement, type) {
            if(drag) {
                return; // we are already dragging.. silently ignore
            }
            drag = dragStore(type);
            drag.start(startCoordsMouse, dragContainer, dragElement);
        };

        dragStore.end = function() {
            if(!drag) {
                return; // there is no dragging going on.. silently ignore
            }
            drag.end();
            drag = null;
        };

        return dragStore;
    }])

    .run(["$document", "dragStore", function($document, dragStore) {
        function mouseMove(e) {
            var drag = dragStore();
            drag && drag.drag(drag.mouse(e));

        }

        function mouseUp(e) {
            if(e.button !== 0) return;
            e.preventDefault();
            dragStore.end();
        }

        $document.bind("mousemove", mouseMove);
        $document.bind("mouseup", mouseUp);
    }])


    // When a drag element is dropped on a drag background, a new dragContainer element will be created containing
    // only the dragged element.
    .directive("dragBackground", ["dragStore", "Drag", function(dragStore, Drag) {
        return {
            link: function(scope, elem, attr) {
                var type = attr.dragBackground;
                var drag = dragStore(type);
                var unregister = drag.registerBackground(new Drag.Background(elem));

                scope.$on("$destroy", unregister);
            }
        };
    }])

    // When a drag element is dropped in a dragContainer, the element will be placed in this container.
    .directive("dragContainer", ["dragStore", "Drag", function(dragStore, Drag) {
        return {
            scope: {
                type: "@dragContainer",
                data: "=containerData",
                horizontal: "@dragHorizontal"
            },
            controller: function($scope) {
                this.startDrag = function(startCoordsMouse, dragElt) {
                    $scope.startDrag && $scope.startDrag(startCoordsMouse, dragElt);
                };
            },
            link: function(scope, elem) {
                var drag = dragStore(scope.type);
                var dragContainer;
                if(_.isUndefined(scope.horizontal)) {
                    dragContainer = new Drag.Container(elem, scope.data);
                } else {
                    dragContainer = new Drag.Container(elem, scope.data, scope.horizontal === "true");
                }
                var unregister = drag.registerContainer(dragContainer);

                scope.startDrag = function(startCoordsMouse, dragElt) {
                    dragStore.start(startCoordsMouse, dragContainer, dragElt, scope.type);
                };

                scope.$on("$destroy", unregister);
            }
        };
    }])

    // A dragElement is the element that will be dragged
    .directive("dragElement", ["dragStore", "Drag", function(dragStore, Drag) {
        return {
            require: "^dragContainer",
            restrict: "A", // necessary because the attribute is searched in the Drag object
            scope: {
                type: "@dragElement",
                data: "=elementData"
            },
            controller: function($scope) {
                this.startDrag = function(startCoordsMouse) {
                    $scope.startDrag && $scope.startDrag(startCoordsMouse);
                };
            },
            link: function(scope, elem, attr, dragContainerCtrl) {
                elem.addClass("drag-element");
                var drag = dragStore(scope.type);
                var dragElt = new Drag.Element(elem, scope.data);
                var unregister = drag.registerElement(dragElt);

                scope.startDrag = function(startCoordsMouse) {
                    dragContainerCtrl.startDrag(startCoordsMouse, dragElt);
                };

                scope.$on("$destroy", unregister);
            }
        };
    }])

    // A dragHandle must be inside of a dragElement and triggers the drag start on this element
    .directive("dragHandle", ["Drag", function(Drag) {
        return {
            require: "^dragElement",
            link: function(scope, elem, attr, dragElementCtrl) {
                elem.css("cursor", "move");

                var dragThreshold = 20; // drag this far in px before really starting
                var startCoords = null;
                function mouseDown(e) {
                    if(e.button !== 0) return;
                    e.preventDefault();
                    startCoords = Drag.mouse(e);
                }

                function mouseUp(e) {
                    if(e.button !== 0) return;
                    e.preventDefault();
                    startCoords = null;
                }

                function mouseMove(e) {
                    if(!startCoords || e.button !== 0) return;
                    e.preventDefault();
                    var coords = Drag.mouse(e);
                    if( Math.abs(coords[0]-startCoords[0]) >= dragThreshold ||
                        Math.abs(coords[1]-startCoords[1]) >= dragThreshold) {
                        dragElementCtrl.startDrag(startCoords);
                        startCoords = null;
                    }
                }

                function mouseLeave(e) {
                    if(e.button !== 0) return;
                    e.preventDefault();
                    // if mouse leaves, we will no longer receive mousemove events, so in this case
                    // we will just start the drag
                    startCoords && dragElementCtrl.startDrag(startCoords);
                    startCoords = null;
                }

                elem.bind("mousedown", mouseDown);
                elem.bind("mouseup", mouseUp);
                elem.bind("mousemove", mouseMove);
                elem.bind("mouseleave", mouseLeave);

                scope.$on("$destroy", function() {
                    elem.unbind("mousedown", mouseDown);
                    elem.unbind("mouseup", mouseUp);
                    elem.unbind("mousemove", mouseUp);
                    elem.unbind("mouseleave", mouseLeave);
                });
            }
        };
    }]);
