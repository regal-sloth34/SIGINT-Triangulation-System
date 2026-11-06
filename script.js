// API key is entered in the app and kept in localStorage
const API_KEY_STORAGE_KEY = 'sigint-triangulation-api-key';

function loadApiKey() {
    try {
        return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
    } catch (error) {
        console.warn('Could not load API key:', error);
        return '';
    }
}

let key = loadApiKey();

function cartoUrl() {
    return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' + (key ? '?key=' + encodeURIComponent(key) : '');
}

// Initialize Leaflet map with dark theme
const darkMap = L.tileLayer(cartoUrl(), {
    attribution: '©OpenStreetMap, ©CartoDB',
    maxZoom: 19,
    crossOrigin: true // lets the loaded tiles be drawn onto the image export canvas
});

// Initial map view, in Switzerland where the swisstopo maps are available
const START_COORDS = [46.84061,6.91782];
const START_ZOOM = 12; // Appropriate zoom level for city view

const map = L.map('map', {
    center: START_COORDS,
    zoom: START_ZOOM
});

// swisstopo maps from geo.admin.ch (Web Mercator WMTS, Switzerland and Liechtenstein only)
function swisstopoLayer(layerId, maxNativeZoom) {
    return L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layerId}/default/current/3857/{z}/{x}/{y}.jpeg`, {
        attribution: '©swisstopo',
        maxNativeZoom,
        maxZoom: 19,
        crossOrigin: true
    });
}

const baseLayers = {
    'swisstopo Map': swisstopoLayer('ch.swisstopo.pixelkarte-farbe', 18),
    'swisstopo Map (grey)': swisstopoLayer('ch.swisstopo.pixelkarte-grau', 18),
    'swisstopo Aerial': swisstopoLayer('ch.swisstopo.swissimage', 19),
    'CARTO': darkMap
};
const DEFAULT_BASE_LAYER = 'swisstopo Map (grey)';
let activeBaseLayer = DEFAULT_BASE_LAYER;
baseLayers[activeBaseLayer].addTo(map);

L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', e => {
    activeBaseLayer = e.name;
    saveState();
});

// Separate layer groups so POIs and measurements survive re-triangulation
const vectorLayer = L.layerGroup().addTo(map); // receivers and bearing lines, drawn live
const distanceLayer = L.layerGroup().addTo(map); // line between the two POIs picked in the distance tool
const poiLayer = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);

// Triangulation results are POIs of type 'target'. The current target belongs to the
// signal being entered: triangulating again moves it, a new signal starts a new one.
let currentTarget = null;
let triangulatedGeometry = null; // vectors the current target was computed from
let targetStale = false; // bearings changed since the current target was computed
let pois = [];
let poiCount = 0;
let activeTool = null; // 'poi' | 'measure' | 'distance' | null
let currentMeasure = null;
let measurements = []; // point arrays, one per measurement path
let restoring = false; // suppresses saving while restoring saved state

// Icons as SVG path data so the map (SVG) and the image export (canvas Path2D) draw
// the same shapes. 'color' is replaced with the marker's colour.
const OUTLINE = 'rgba(15, 17, 23, 0.85)';

const RX_TOWER = 'M14 11 L8.5 33 M14 11 L19.5 33 M10.25 26 L17.75 26 M12 19 L16 19 M6 33 L22 33';
const RX_WAVES = 'M17.54 5.46 A5 5 0 0 1 17.54 12.54 M10.46 5.46 A5 5 0 0 0 10.46 12.54 ' +
    'M20.36 2.64 A9 9 0 0 1 20.36 15.36 M7.64 2.64 A9 9 0 0 0 7.64 15.36';
const RX_ICON = {
    size: [28, 36],
    anchor: [14, 33], // centre of the mast's base line
    parts: [
        { d: RX_TOWER + ' ' + RX_WAVES, stroke: OUTLINE, width: 4.5 },
        { d: RX_TOWER + ' ' + RX_WAVES, stroke: 'color', width: 2 },
        { d: 'M11.6 9 a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0', fill: 'color', stroke: OUTLINE, width: 1.5 }
    ]
};

const TARGET_RING = 'M12 24 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0';
const TARGET_TICKS = 'M24 1 L24 9 M24 39 L24 47 M1 24 L9 24 M39 24 L47 24';
const TARGET_ICON = {
    size: [48, 48],
    anchor: [24, 24],
    parts: [
        { d: 'M4 24 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0', fill: 'rgba(255, 59, 59, 0.18)' },
        { d: TARGET_RING + ' ' + TARGET_TICKS, stroke: OUTLINE, width: 5 },
        { d: TARGET_RING + ' ' + TARGET_TICKS, stroke: 'color', width: 2.5 },
        { d: 'M20.5 24 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0', fill: 'color', stroke: OUTLINE, width: 1.5 }
    ]
};

const POI_ICON = {
    size: [16, 16],
    anchor: [8, 8],
    parts: [
        { d: 'M2 8 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0', fill: 'color', stroke: '#ffffff', width: 2 }
    ]
};

// Broadcast symbol ((•)) for transmitters / signal sources
const TX_WAVES = 'M21.3 6.7 A7.5 7.5 0 0 1 21.3 17.3 M10.7 6.7 A7.5 7.5 0 0 0 10.7 17.3 ' +
    'M24.49 3.51 A12 12 0 0 1 24.49 20.49 M7.51 3.51 A12 12 0 0 0 7.51 20.49';
const TX_ICON = {
    size: [32, 24],
    anchor: [16, 12],
    parts: [
        { d: TX_WAVES, stroke: OUTLINE, width: 4.5 },
        { d: TX_WAVES, stroke: 'color', width: 2 },
        { d: 'M12.5 12 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0', fill: 'color', stroke: OUTLINE, width: 1.5 }
    ]
};

const POI_TYPES = {
    target: { label: 'Target', icon: TARGET_ICON, color: '#ff3b3b', pulse: true },
    transmitter: { label: 'Transmitter', icon: TX_ICON, color: '#ff922b' },
    poi: { label: 'POI', icon: POI_ICON, color: '#be4bdb' }
};

function iconSvg(icon, color) {
    const [w, h] = icon.size;
    const paths = icon.parts.map(part => {
        const fill = part.fill ? (part.fill === 'color' ? color : part.fill) : 'none';
        const stroke = part.stroke ? `stroke="${part.stroke === 'color' ? color : part.stroke}" stroke-width="${part.width}"` : '';
        return `<path d="${part.d}" fill="${fill}" ${stroke} stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function rxIcon(color) {
    return L.divIcon({
        className: 'rx-marker',
        html: iconSvg(RX_ICON, color),
        iconSize: RX_ICON.size,
        iconAnchor: RX_ICON.anchor
    });
}

// Map labels: names of receivers and POIs, and distances on measurement lines.
// All labels are laid out together so they avoid each other and the icons; the image
// export draws the same layout.
const LABEL_FONT = '600 12px "Roboto Mono", monospace';
const LABEL_HEIGHT = 20;
const LABEL_GAP = 3; // between a label and its icon
const labelMeasureCtx = document.createElement('canvas').getContext('2d');

const labelPane = map.createPane('labels');
labelPane.style.zIndex = 650; // above markers, below popups
labelPane.style.pointerEvents = 'none';

function labelWidth(text) {
    labelMeasureCtx.font = LABEL_FONT;
    return Math.ceil(labelMeasureCtx.measureText(text).width) + 14; // padding and border
}

function labelStyle(label) {
    return label.line ?
        { background: '#fcc419', border: OUTLINE, text: '#0f1117' } :
        { background: 'rgba(15, 17, 23, 0.85)', border: label.color, text: label.color };
}

function markerIconSpec(exportAs) {
    return exportAs.kind === 'rx' ? RX_ICON : (POI_TYPES[exportAs.type] || POI_TYPES.poi).icon;
}

function markerColor(exportAs) {
    return exportAs.kind === 'rx' ? exportAs.color : (POI_TYPES[exportAs.type] || POI_TYPES.poi).color;
}

function boxOverlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

// Candidate boxes around a marker icon, nearest positions first
function markerLabelCandidates(icon, w, h, preferRight) {
    const g = LABEL_GAP;
    const cx = icon.x + icon.w / 2;
    const cy = icon.y + icon.h / 2;
    const candidates = [];
    for (let ring = 0; ring < 3; ring++) {
        const d = ring * (h + 2);
        const above = { x: cx - w / 2, y: icon.y - g - h - d };
        const right = { x: icon.x + icon.w + g + d, y: cy - h / 2 };
        const below = { x: cx - w / 2, y: icon.y + icon.h + g + d };
        const left = { x: icon.x - g - w - d, y: cy - h / 2 };
        const aboveRight = { x: icon.x + icon.w - 4 + d, y: icon.y - h + 4 - d };
        const aboveLeft = { x: icon.x - w + 4 - d, y: icon.y - h + 4 - d };
        const belowRight = { x: icon.x + icon.w - 4 + d, y: icon.y + icon.h - 4 + d };
        const belowLeft = { x: icon.x - w + 4 - d, y: icon.y + icon.h - 4 + d };
        candidates.push(...(preferRight ?
            [right, aboveRight, belowRight, above, below, left, aboveLeft, belowLeft] :
            [above, right, left, below, aboveRight, aboveLeft, belowRight, belowLeft]));
    }
    return candidates.map(c => ({ ...c, w, h }));
}

// Candidate boxes on a line: centred on its middle first, then moved along and off it
function lineLabelCandidates(a, b, w, h) {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const along = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const normal = { x: -along.y, y: along.x };
    const offsets = [[0, 0]];
    for (let k = 1; k <= 3; k++) {
        const s = k * (h + 4);
        offsets.push([0, s], [0, -s], [k * len * 0.12, 0], [-k * len * 0.12, 0]);
    }
    return offsets.map(([t, n]) => ({
        x: mid.x + along.x * t + normal.x * n - w / 2,
        y: mid.y + along.y * t + normal.y * n - h / 2,
        w,
        h
    }));
}

// Collect every label and place each on its first free candidate; returns boxes in
// container pixels
function computeLabelLayout() {
    const size = map.getSize();
    const view = { x: 0, y: 0, w: size.x, h: size.y };
    const nearView = p => p.x > -200 && p.y > -200 && p.x < size.x + 200 && p.y < size.y + 200;
    const labels = [];
    const icons = [];

    [vectorLayer, poiLayer].forEach(group => group.eachLayer(layer => {
        const o = layer.options.exportAs;
        if (!o) return;
        const p = map.latLngToContainerPoint(layer.getLatLng());
        if (!nearView(p)) return;
        const spec = markerIconSpec(o);
        const icon = { x: p.x - spec.anchor[0], y: p.y - spec.anchor[1], w: spec.size[0], h: spec.size[1] };
        icons.push(icon);
        const w = labelWidth(o.name);
        labels.push({
            text: o.name,
            color: markerColor(o),
            priority: o.type === 'target' ? 0 : o.type === 'transmitter' ? 2 : o.kind === 'rx' ? 3 : 4,
            own: icon,
            candidates: markerLabelCandidates(icon, w, LABEL_HEIGHT, o.kind === 'rx')
        });
    }));

    // Distances sit in the middle of their line (ends in container pixels)
    const lineLabel = (pa, pb, text, priority) => {
        if (!nearView({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 })) return;
        labels.push({ text, line: true, priority, candidates: lineLabelCandidates(pa, pb, labelWidth(text), LABEL_HEIGHT) });
    };

    const from = pois.find(p => p.id === distancePair.from);
    const to = pois.find(p => p.id === distancePair.to);
    if (from && to && from !== to) {
        const km = calculateDistance(from.position, to.position);
        // The line is a great circle; label its true middle
        const mid = destinationPoint(from.position, calculateBearing(from.position, to.position), km / 2);
        const pm = map.latLngToContainerPoint(mid);
        const pf = map.latLngToContainerPoint(from.position);
        const pt = map.latLngToContainerPoint(to.position);
        // Same direction as the whole line, centred on the middle point
        const half = { x: (pt.x - pf.x) / 2, y: (pt.y - pf.y) / 2 };
        lineLabel({ x: pm.x - half.x, y: pm.y - half.y }, { x: pm.x + half.x, y: pm.y + half.y }, formatDistance(km), 1);
    }

    measurements.forEach(points => {
        let total = 0;
        points.slice(1).forEach((point, i) => {
            const leg = calculateDistance(points[i], point);
            total += leg;
            lineLabel(map.latLngToContainerPoint(points[i]), map.latLngToContainerPoint(point), formatDistance(leg), 1);
        });
        // Several legs also get their total at the end
        if (points.length > 2) {
            const p = map.latLngToContainerPoint(points[points.length - 1]);
            const text = `Total ${formatDistance(total)}`;
            const end = { x: p.x - 4, y: p.y - 4, w: 8, h: 8 };
            labels.push({ text, line: true, priority: 1, own: end, candidates: markerLabelCandidates(end, labelWidth(text), LABEL_HEIGHT, true) });
        }
    });

    const placed = [];
    labels.sort((a, b) => a.priority - b.priority).forEach(label => {
        const obstacles = icons.filter(icon => icon !== label.own);
        let best = null;
        let bestCost = Infinity;
        for (const box of label.candidates) {
            let cost = 0;
            placed.forEach(other => { cost += boxOverlap(box, other) * 4; });
            obstacles.forEach(icon => { cost += boxOverlap(box, icon); });
            cost += box.w * box.h - boxOverlap(box, view); // keep labels inside the map
            if (cost < bestCost) {
                best = box;
                bestCost = cost;
                if (cost === 0) break;
            }
        }
        placed.push({ ...best, text: label.text, color: label.color, line: label.line });
    });

    return placed.filter(label => boxOverlap(label, view) > 0);
}

let labelFrame = null; // pending layout timer

// Re-layout labels once after a batch of changes to markers, lines or the view
function scheduleLabels() {
    if (labelFrame !== null) return;
    labelFrame = setTimeout(() => {
        labelFrame = null;
        layoutLabels();
    });
}

function layoutLabels() {
    labelPane.innerHTML = '';
    computeLabelLayout().forEach(label => {
        const style = labelStyle(label);
        const div = document.createElement('div');
        div.className = 'map-label';
        div.textContent = label.text;
        const pos = map.containerPointToLayerPoint([label.x, label.y]);
        Object.assign(div.style, {
            left: `${pos.x}px`,
            top: `${pos.y}px`,
            width: `${label.w}px`,
            height: `${label.h}px`,
            lineHeight: `${label.h - 2}px`,
            background: style.background,
            borderColor: style.border,
            color: style.text
        });
        labelPane.appendChild(div);
    });
    labelPane.hidden = false;
}

// Labels are hidden during zoom animations and laid out again for the new zoom
map.on('zoomstart', () => { labelPane.hidden = true; });
map.on('zoomend moveend resize', scheduleLabels);
document.fonts?.ready.then(scheduleLabels);

// Receivers stay in the list between signals; for each signal you only tick the ones
// that received it and enter their bearings
let receivers = []; // { id, name, position, bearing, enabled }, text as typed
let receiverCount = 0;

function addReceiver(values = {}) {
    receiverCount++;
    receivers.push({
        id: receiverCount,
        name: values.name || '',
        position: values.position || '',
        bearing: values.bearing || '',
        enabled: values.enabled ?? Boolean(values.bearing)
    });
    renderReceivers();
    drawVectors();
    saveState();
}

function removeReceiver(receiver) {
    if (receiver.position.trim() && !confirm(`Remove receiver ${receiverName(receiver)}?`)) return;
    receivers = receivers.filter(r => r !== receiver);
    renderReceivers();
    drawVectors();
    saveState();
}

function receiverName(receiver) {
    return receiver.name.trim() || `RX ${receivers.indexOf(receiver) + 1}`;
}

function receiverColor(receiver) {
    return `hsl(${(receivers.indexOf(receiver) * 360) / receivers.length}, 100%, 50%)`;
}

function textInput(value, placeholder) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    return input;
}

function colorSwatch(color) {
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = color;
    return swatch;
}

// Build both views of the receivers: the station list (name, location) and the
// signal list (received checkbox, bearing)
function renderReceivers() {
    const stationList = document.getElementById('receiver-list');
    const bearingList = document.getElementById('bearing-list');
    stationList.innerHTML = '';
    bearingList.innerHTML = '';
    document.getElementById('receiver-empty').hidden = receivers.length > 0;
    document.getElementById('bearing-empty').hidden = receivers.length > 0;
    document.getElementById('receiver-count').textContent = receivers.length;

    receivers.forEach((receiver, index) => {
        const color = receiverColor(receiver);

        const bearingItem = document.createElement('div');
        bearingItem.className = 'bearing-item';
        const label = document.createElement('label');
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = receiver.enabled;
        enabled.title = 'Received this signal';
        const nameText = document.createElement('span');
        nameText.className = 'bearing-name';
        label.append(enabled, colorSwatch(color), nameText);
        const bearing = textInput(receiver.bearing, '45 or 40-55');
        bearing.inputMode = 'decimal';
        bearingItem.append(label, bearing);
        bearingList.appendChild(bearingItem);

        const stationItem = document.createElement('div');
        stationItem.className = 'receiver-item';
        const name = textInput(receiver.name, `RX ${index + 1}`);
        const position = textInput(receiver.position, 'Lat,Lng');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-button danger-hover';
        remove.title = 'Remove receiver';
        remove.textContent = '✕';
        stationItem.append(colorSwatch(color), name, position, remove);
        stationList.appendChild(stationItem);

        const refresh = () => {
            const located = parseCoords(receiver.position) !== null;
            nameText.textContent = receiverName(receiver);
            nameText.title = located ? receiver.position : 'No valid location set for this receiver';
            bearingItem.classList.toggle('off', !receiver.enabled);
            bearingItem.classList.toggle('unlocated', !located);
            position.classList.toggle('invalid', receiver.position.trim() !== '' && !located);
            bearing.classList.toggle('invalid',
                receiver.bearing.trim() !== '' && !isValidBearing(parseBearing(receiver.bearing).bearing));
        };
        const changed = () => {
            refresh();
            drawVectors();
            saveState();
        };

        name.addEventListener('input', () => { receiver.name = name.value; changed(); });
        position.addEventListener('input', () => { receiver.position = position.value; changed(); });
        bearing.addEventListener('input', () => {
            receiver.bearing = bearing.value;
            // Entering a bearing means this receiver got the signal
            if (bearing.value.trim()) enabled.checked = receiver.enabled = true;
            changed();
        });
        enabled.addEventListener('change', () => { receiver.enabled = enabled.checked; changed(); });
        remove.addEventListener('click', () => removeReceiver(receiver));
        refresh();
    });
}

// Start a new signal: keep the receivers, clear the bearings and report fields
function newSignal() {
    receivers.forEach(receiver => {
        receiver.bearing = '';
        receiver.enabled = false;
    });
    ['report-time', 'report-sign', 'report-freq'].forEach(id => { document.getElementById(id).value = ''; });
    // The previous target stays on the map as a POI; the next triangulation adds a new one
    currentTarget = null;
    triangulatedGeometry = null;
    renderReceivers();
    drawVectors();
    renderTargetPanel();
    saveState();
}

// Empty the session without saving the intermediate state
function resetSession() {
    setMapTool(null);
    restoring = true;
    try {
        receivers = [];
        receiverCount = 0;
        ['report-time', 'report-sign', 'report-freq'].forEach(id => { document.getElementById(id).value = ''; });
        poiLayer.clearLayers();
        pois = [];
        poiCount = 0;
        currentTarget = null;
        triangulatedGeometry = null;
        targetStale = false;
        distancePair = { from: null, to: null };
        clearMeasurements();
    } finally {
        restoring = false;
    }
}

// Remove everything: receivers, signal, POIs (including targets) and measurements
function clearAll() {
    if (!confirm('Clear everything? This removes all receivers, POIs, targets and measurements.')) return;
    resetSession();
    document.getElementById('receiver-panel').open = true;
    renderReceivers();
    drawVectors();
    renderPoiList();
    renderTargetPanel();
    saveState();
}

// Process the input data
function processData() {
    const active = receivers.filter(r => r.enabled);
    if (active.length < 2) {
        alert('Tick at least two receivers that received the signal.');
        return;
    }

    try {
        const data = active.map(receiver => {
            const d = readReceiver(receiver);
            if (!d.position) {
                throw new Error(`${d.name}: invalid location. Use Lat,Lng format with valid ranges.`);
            }
            if (!isValidBearing(d.bearing)) {
                throw new Error(`${d.name}: bearing must be a number from 0 to 360, or a range like 40-55.`);
            }
            return d;
        });

        calculateIntersection(data);
    } catch (error) {
        alert(error.message);
    }
}

function readReceiver(receiver) {
    return {
        name: receiverName(receiver),
        position: parseCoords(receiver.position),
        ...parseBearing(receiver.bearing)
    };
}

function isValidBearing(bearing) {
    return !isNaN(bearing) && bearing >= 0 && bearing <= 360;
}

// Parse "45" or a range "40-55" (clockwise, so "350-10" spans north) into its centre
// bearing and width in degrees
function parseBearing(text) {
    const match = text.trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
    const invalid = { bearing: NaN, bearingWidth: 0, bearingFrom: NaN };
    if (!match) return invalid;

    const from = parseFloat(match[1]);
    const to = match[2] === undefined ? from : parseFloat(match[2]);
    if (!isValidBearing(from) || !isValidBearing(to)) return invalid;

    const width = (to - from + 360) % 360;
    return { bearing: (from + width / 2) % 360, bearingWidth: width, bearingFrom: from };
}

function formatBearing(d) {
    if (!d.bearingWidth) return `${+d.bearing.toFixed(2)}°`;
    const to = (d.bearingFrom + d.bearingWidth) % 360;
    return `${+d.bearingFrom.toFixed(2)}–${+to.toFixed(2)}° (centre ${+d.bearing.toFixed(2)}°)`;
}

// Draw each receiver and its bearing vector as soon as its row has valid values
function drawVectors() {
    vectorLayer.clearLayers();

    const lines = [];

    receivers.forEach(receiver => {
        if (!receiver.enabled) return;
        const d = readReceiver(receiver);
        if (!d.position) return;

        const lineColor = receiverColor(receiver);
        const hasBearing = isValidBearing(d.bearing);

        if (hasBearing) {
            if (d.bearingWidth > 0) {
                // Wedge covering the bearing range, bounded by the two edge great circles
                const steps = Math.max(2, Math.ceil(d.bearingWidth / 2));
                const farArc = Array.from({ length: steps + 1 }, (_, i) =>
                    destinationPoint(d.position, d.bearingFrom + (d.bearingWidth * i) / steps, MAX_LINE_LENGTH));
                const outline = [
                    ...greatCirclePath(d.position, d.bearingFrom, MAX_LINE_LENGTH),
                    ...farArc,
                    ...greatCirclePath(d.position, d.bearingFrom + d.bearingWidth, MAX_LINE_LENGTH).reverse()
                ];
                L.polygon(unwrapLongitudes(outline), {
                    color: lineColor,
                    weight: 1,
                    opacity: 0.6,
                    fillColor: lineColor,
                    fillOpacity: 0.15
                }).addTo(vectorLayer);
            }
            L.polyline(greatCirclePath(d.position, d.bearing, MAX_LINE_LENGTH), {
                color: lineColor,
                weight: 2,
                opacity: 0.8,
                dashArray: d.bearingWidth > 0 ? '6 6' : null
            }).addTo(vectorLayer);
            lines.push({
                start: d.position,
                bearing: d.bearing,
                width: d.bearingWidth
            });
        }

        L.marker(d.position, {
                icon: rxIcon(lineColor),
                exportAs: { kind: 'rx', name: d.name, color: lineColor }
            })
            .addTo(vectorLayer)
            .bindPopup(`
            <b>${escapeHtml(d.name)}</b><br>
            Bearing: ${hasBearing ? formatBearing(d) : '—'}
        `);
    });

    // A target computed from different vectors is out of date until triangulated again
    const stale = currentTarget !== null && JSON.stringify(lines) !== triangulatedGeometry;
    if (stale !== targetStale) {
        targetStale = stale;
        renderTargetPanel();
    }

    scheduleLabels();
    return lines;
}

// Show the current signal's target (its POI can be moved or renamed in the POI list)
function renderTargetPanel() {
    const coords = document.getElementById('result-coords');
    const details = document.getElementById('target-details');
    if (!currentTarget) {
        coords.textContent = 'Coordinates: Awaiting triangulation...';
        details.hidden = true;
        return;
    }
    coords.textContent = `${currentTarget.name}: ${formatCoords(currentTarget.position)}`;
    const confidence = document.getElementById('confidence-value');
    confidence.textContent = currentTarget.confidence || '—';
    confidence.style.color = CONFIDENCE_COLORS[currentTarget.confidence] || '';
    document.getElementById('target-stale').hidden = !targetStale;
    details.hidden = false;
}

function defaultTargetName() {
    const sign = document.getElementById('report-sign').value.trim();
    const freq = document.getElementById('report-freq').value.trim();
    const label = [sign, freq && `${freq} MHz`].filter(Boolean).join(' ');
    return label || `Target ${pois.filter(p => p.type === 'target').length + 1}`;
}

// Calculate the intersection of the bearing vectors and mark the target
function calculateIntersection(data, { silent = false } = {}) {
    drawVectors();

    const lines = data.map(d => ({
        start: d.position,
        bearing: d.bearing,
        width: d.bearingWidth
    }));

    const bounds = L.latLngBounds(data.map(d => d.position));

    const intersection = calculateGeodesicIntersection(lines);
    if (intersection) {
        bounds.extend(intersection);

        // Re-triangulating the same signal moves its target instead of adding another
        if (currentTarget && pois.includes(currentTarget)) {
            currentTarget.position = intersection;
            currentTarget.marker.setLatLng(intersection);
        } else {
            currentTarget = addPoi(intersection, defaultTargetName(), 'target');
        }
        currentTarget.confidence = confidenceLevel(lines, intersection);
        triangulatedGeometry = JSON.stringify(lines);
        targetStale = false;
        renderPoiList();
        renderTargetPanel();
        saveState();
    } else {
        if (!silent) alert(`No intersection found. Check that the bearings converge and are not parallel.`);
        document.getElementById('result-coords').textContent = 'Coordinates: No valid intersection found';
        document.getElementById('target-details').hidden = true;
    }

    // Fit the map to the receivers and the target
    map.fitBounds(bounds.pad(0.3));
}

// Bearing lines run along the great circle almost to the antipode (half the
// Earth's circumference, ~20015 km), where all bearings from a point meet again
const MAX_LINE_LENGTH = 20000; // km

// Points along the great circle from start on the given bearing, with
// longitudes unwrapped so Leaflet draws it as one continuous line.
// Leaflet joins the points with straight lines on the Mercator map, but a great circle
// curves there, so long steps would make the drawn line miss the computed target.
// Steps grow with distance (2% of it), keeping the drawn line within a metre of the true
// bearing near the receivers, where fixes are made.
function greatCirclePath(start, bearing, distance) {
    const points = [destinationPoint(start, bearing, 0)];
    for (let d = 0; d < distance;) {
        d = Math.min(distance, d + Math.min(100, Math.max(0.05, d * 0.02)));
        points.push(destinationPoint(start, bearing, d));
    }
    return unwrapLongitudes(points);
}

// Shift each longitude by multiples of 360° so consecutive points never jump across the antimeridian
function unwrapLongitudes(points) {
    let prev = null;
    return points.map(([lat, lng]) => {
        if (prev !== null) {
            lng += Math.round((prev - lng) / 360) * 360;
        }
        prev = lng;
        return [lat, lng];
    });
}

// Calculate the destination point given start point, bearing and distance
function destinationPoint([lat, lng], bearing, distance) {
    const R = 6371; // Earth's radius in km
    const d = distance / R;
    const bearingRad = (bearing * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lng1 = (lng * Math.PI) / 180;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(bearingRad)
    );

    const lng2 = lng1 + Math.atan2(
        Math.sin(bearingRad) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

    return [
        (lat2 * 180) / Math.PI,
        (lng2 * 180) / Math.PI
    ];
}

// Find geodesic intersection of multiple bearing lines
function calculateGeodesicIntersection(lines) {
    const intersections = [];

    for (let i = 0; i < lines.length - 1; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            const intersection = geodesicIntersection(
                lines[i].start,
                lines[i].bearing,
                lines[j].start,
                lines[j].bearing
            );
            if (intersection) {
                // Crossings of tight bearings count for more than crossings of wide ranges
                intersections.push({
                    point: intersection,
                    weight: 1 / ((1 + lines[i].width) * (1 + lines[j].width))
                });
            }
        }
    }

    if (intersections.length === 0) return null;

    // Calculate weighted center point of all intersections
    const totalWeight = intersections.reduce((sum, x) => sum + x.weight, 0);
    const avgLat = intersections.reduce((sum, x) => sum + x.point[0] * x.weight, 0) / totalWeight;
    const avgLng = intersections.reduce((sum, x) => sum + x.point[1] * x.weight, 0) / totalWeight;

    return [avgLat, avgLng];
}

// Calculate intersection of two geodesics
function geodesicIntersection([lat1, lng1], brng1, [lat2, lng2], brng2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const λ1 = (lng1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const λ2 = (lng2 * Math.PI) / 180;
    const θ13 = (brng1 * Math.PI) / 180;
    const θ23 = (brng2 * Math.PI) / 180;
    const Δφ = φ2 - φ1;
    const Δλ = λ2 - λ1;

    const δ12 = 2 * Math.asin(Math.sqrt(
        Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
    ));

    if (Math.abs(δ12) < 1e-10) return null;

    const θa = Math.acos(
        (Math.sin(φ2) - Math.sin(φ1) * Math.cos(δ12)) /
        (Math.sin(δ12) * Math.cos(φ1))
    );

    const θb = Math.acos(
        (Math.sin(φ1) - Math.sin(φ2) * Math.cos(δ12)) /
        (Math.sin(δ12) * Math.cos(φ2))
    );

    const θ12 = Math.sin(λ2 - λ1) > 0 ? θa : 2 * Math.PI - θa;
    const θ21 = Math.sin(λ2 - λ1) > 0 ? 2 * Math.PI - θb : θb;

    const α1 = (θ13 - θ12 + Math.PI) % (2 * Math.PI) - Math.PI;
    const α2 = (θ21 - θ23 + Math.PI) % (2 * Math.PI) - Math.PI;

    if (Math.sin(α1) === 0 && Math.sin(α2) === 0) return null;
    if (Math.sin(α1) * Math.sin(α2) < 0) return null;

    const α3 = Math.acos(
        -Math.cos(α1) * Math.cos(α2) +
        Math.sin(α1) * Math.sin(α2) * Math.cos(δ12)
    );

    const δ13 = Math.atan2(
        Math.sin(δ12) * Math.sin(α1) * Math.sin(α2),
        Math.cos(α2) + Math.cos(α1) * Math.cos(α3)
    );

    const φ3 = Math.asin(
        Math.sin(φ1) * Math.cos(δ13) +
        Math.cos(φ1) * Math.sin(δ13) * Math.cos(θ13)
    );

    const Δλ13 = Math.atan2(
        Math.sin(θ13) * Math.sin(δ13) * Math.cos(φ1),
        Math.cos(δ13) - Math.sin(φ1) * Math.sin(φ3)
    );

    const λ3 = λ1 + Δλ13;

    return [(φ3 * 180) / Math.PI, (λ3 * 180) / Math.PI];
}

const CONFIDENCE_COLORS = {
    'Very High': '#51cf66',
    'High': '#94d82d',
    'Medium': '#fcc419',
    'Low': '#fa5252'
};

// Confidence level based on intersection spread
function confidenceLevel(lines, intersection) {
    const distances = lines.map(line => {
        return calculateDistance(line.start, intersection);
    });

    const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
    const spread = Math.max(...distances) - Math.min(...distances);

    const levels = ["Very High", "High", "Medium", "Low"];
    let level;
    if (spread < avgDistance * 0.1) level = 0;
    else if (spread < avgDistance * 0.2) level = 1;
    else if (spread < avgDistance * 0.3) level = 2;
    else level = 3;

    // Wide bearing ranges make the fix less certain
    const avgWidth = lines.reduce((sum, line) => sum + (line.width || 0), 0) / lines.length;
    if (avgWidth >= 30) level += 2;
    else if (avgWidth >= 10) level += 1;
    return levels[Math.min(level, levels.length - 1)];
}

// Calculate distance between two points in km
function calculateDistance(point1, point2) {
    const [lat1, lon1] = point1;
    const [lat2, lon2] = point2;
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Render the map with its lines and markers onto a canvas. The tiles already on screen
// are drawn directly (they are loaded with CORS), so nothing is downloaded again.
async function renderMapCanvas() {
    // Give tiles that are still loading a moment, then draw whatever is there
    const loading = [];
    map.eachLayer(layer => {
        if (layer instanceof L.TileLayer && layer.isLoading()) {
            loading.push(new Promise(resolve => layer.once('load', resolve)));
        }
    });
    if (loading.length) {
        await Promise.race([Promise.all(loading), new Promise(resolve => setTimeout(resolve, 3000))]);
    }

    const size = map.getSize();
    const scale = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size.x * scale);
    canvas.height = Math.round(size.y * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#dddddd';
    ctx.fillRect(0, 0, size.x, size.y);

    // Tiles, lower zoom levels first (Leaflet keeps the current level on top via z-index)
    const mapRect = map.getContainer().getBoundingClientRect();
    map.eachLayer(layer => {
        if (!(layer instanceof L.TileLayer)) return;
        Array.from(layer.getContainer().querySelectorAll('img.leaflet-tile-loaded'))
            .sort((a, b) => (parseInt(a.parentNode.style.zIndex) || 0) - (parseInt(b.parentNode.style.zIndex) || 0))
            .forEach(img => {
                const r = img.getBoundingClientRect();
                ctx.drawImage(img, r.left - mapRect.left, r.top - mapRect.top, r.width, r.height);
            });
    });

    const lines = [];
    const overlays = [];
    map.eachLayer(layer => {
        if (layer instanceof L.Marker && layer.options.exportAs) {
            overlays.push({ ...layer.options.exportAs, position: layer.getLatLng() });
        } else if (layer instanceof L.Polyline) {
            const polygon = layer instanceof L.Polygon;
            lines.push({
                latlngs: polygon ? layer.getLatLngs()[0] : layer.getLatLngs(),
                polygon,
                color: layer.options.color,
                weight: layer.options.weight,
                opacity: layer.options.opacity,
                fillColor: layer.options.fillColor || layer.options.color,
                fillOpacity: layer.options.fillOpacity,
                dash: layer.options.dashArray ? layer.options.dashArray.split(' ').map(Number) : []
            });
        }
    });

    // Lines and wedges, wedges underneath
    lines.sort((a, b) => b.polygon - a.polygon).forEach(line => {
        const points = line.latlngs.map(latlng => map.latLngToContainerPoint(latlng));
        if (!points.length) return;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        if (line.polygon) {
            ctx.closePath();
            ctx.fillStyle = line.fillColor;
            ctx.globalAlpha = line.fillOpacity;
            ctx.fill();
        }
        ctx.setLineDash(line.dash);
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.weight;
        ctx.globalAlpha = line.opacity;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
    });

    // Measurement points
    measurements.flat().forEach(point => {
        const p = map.latLngToContainerPoint(point);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = '#fcc419';
        ctx.fill();
    });

    // Icons (targets on top), then the same label layout as on screen
    const order = o => o.kind === 'rx' ? 1 : o.type === 'target' ? 2 : 0;
    overlays
        .sort((a, b) => order(a) - order(b))
        .forEach(o => {
            const p = map.latLngToContainerPoint(o.position);
            drawIconOnCanvas(ctx, markerIconSpec(o), p, markerColor(o));
        });
    computeLabelLayout().forEach(label => drawLabelOnCanvas(ctx, label));

    return canvas;
}

function canvasToPng(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
}

function mapImageFilename() {
    return `triangulation-map-${new Date().toISOString().slice(0,10)}.png`;
}

// Download the map as a PNG
async function saveMapImage(png = renderMapCanvas().then(canvasToPng)) {
    try {
        downloadBlob(await png, mapImageFilename());
    } catch (error) {
        console.error('Error rendering map:', error);
        alert('Failed to render the map image. Please try again.');
    }
}

// Copy the map as an image; falls back to downloading it if the clipboard is blocked
async function copyMapImage() {
    const button = document.getElementById('copy-map');
    const png = renderMapCanvas().then(canvasToPng);
    try {
        // The item is created right away with a promise to keep the click's clipboard permission
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        flashButton(button, ' Copied! ');
    } catch (error) {
        console.warn('Could not copy map, downloading instead:', error);
        await saveMapImage(png);
    }
}

// Show a short confirmation on a button, then restore its label
function flashButton(button, text) {
    button.dataset.label ??= button.textContent;
    clearTimeout(button.flashTimer);
    button.textContent = text;
    button.flashTimer = setTimeout(() => { button.textContent = button.dataset.label; }, 1500);
}

// Draws an SVG-style icon (see RX_ICON / TARGET_ICON) with its anchor at p
function drawIconOnCanvas(ctx, icon, { x, y }, color) {
    ctx.save();
    ctx.translate(x - icon.anchor[0], y - icon.anchor[1]);
    icon.parts.forEach(part => {
        const path = new Path2D(part.d);
        if (part.fill) {
            ctx.fillStyle = part.fill === 'color' ? color : part.fill;
            ctx.fill(path);
        }
        if (part.stroke) {
            ctx.lineWidth = part.width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = part.stroke === 'color' ? color : part.stroke;
            ctx.stroke(path);
        }
    });
    ctx.restore();
}

// Draw a placed label (see computeLabelLayout) like the on-map .map-label
function drawLabelOnCanvas(ctx, label) {
    const style = labelStyle(label);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(label.x + 0.5, label.y + 0.5, label.w - 1, label.h - 1, 4);
    ctx.fillStyle = style.background;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = style.border;
    ctx.stroke();
    ctx.font = LABEL_FONT;
    ctx.fillStyle = style.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.text, label.x + label.w / 2, label.y + label.h / 2 + 1);
    ctx.restore();
}

// Current time as HH:MM, rounded to the nearest 10 minutes
function currentTimeRounded() {
    const step = 10 * 60 * 1000;
    const time = new Date(Math.round(Date.now() / step) * step);
    return time.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}

// Copy the report in the Meldung format to the clipboard; empty fields stay open, Zeit defaults to now
async function copyReport() {
    let txtContent = '';
    try {
        // Only receivers that got the signal; default names keep their list numbering
        const sources = receivers.filter(r => r.enabled).map(r => ({
            name: receiverName(r),
            position: r.position.trim(),
            bearing: r.bearing.trim()
        }));

        txtContent = `Meldung: ${new Date().toLocaleDateString('de-CH')}\n`;
        txtContent += `Stao: ${sources.map(s => `${s.name} ${s.position}`.trim()).join(' / ')}\n`;
        txtContent += `Zeit: ${document.getElementById('report-time').value.trim() || currentTimeRounded()}\n`;
        txtContent += `Sign: ${document.getElementById('report-sign').value.trim()}\n`;
        txtContent += `Freq: ${document.getElementById('report-freq').value.trim()}\n`;
        sources.forEach(s => {
            txtContent += `AZ ${s.name}: ${s.bearing ? `${s.bearing}°` : ''}\n`;
        });
        txtContent += `Triangulation: ${currentTarget ? formatCoords(currentTarget.position) : '—'}\n`;
        txtContent += `Interp:`;
    } catch (error) {
        console.error('Error building report:', error);
        alert('Failed to build the report. Please try again.');
        return;
    }

    try {
        await navigator.clipboard.writeText(txtContent);
        flashButton(document.getElementById('copy-report'), ' Copied! ');
    } catch (error) {
        // Clipboard access can be blocked (e.g. over file://), so let the user copy it by hand
        console.error('Error copying report:', error);
        prompt('Could not copy automatically. Copy the report from here:', txtContent);
    }
}

// Format a distance in km for display
function formatDistance(km) {
    return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(2)} km`;
}

function formatCoords([lat, lng]) {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

// Initial bearing from point1 to point2 in degrees (0-360)
function calculateBearing([lat1, lng1], [lat2, lng2]) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Switch between map tools ('poi', 'measure' or null)
function setMapTool(tool) {
    if (activeTool === 'measure') finishMeasurement();
    activeTool = activeTool === tool ? null : tool;

    document.getElementById('poi-mode').classList.toggle('active', activeTool === 'poi');
    document.getElementById('measure-mode').classList.toggle('active', activeTool === 'measure');
    document.getElementById('distance-mode').classList.toggle('active', activeTool === 'distance');
    document.getElementById('map-container').classList.toggle('tool-active', activeTool !== null);

    // Double-click finishes a measurement instead of zooming
    if (activeTool === 'measure') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();

    document.getElementById('map-tool-hint').textContent =
        activeTool === 'poi' ? 'Click the map to place a POI (Esc to stop)' :
        activeTool === 'measure' ? 'Click to add points (click a POI to snap to it), double-click or Esc to finish' :
        activeTool === 'distance' ? 'Click a POI to measure from, then another to measure to (Esc to stop)' :
        '';

    // Clicking a POI with a tool active picks it instead of opening its popup
    renderPoiList();
}

// A POI marker was clicked: tools that work with POIs use its exact position
function onPoiClick(poi) {
    if (activeTool === 'measure') {
        addMeasurePoint(poi.marker.getLatLng());
    } else if (activeTool === 'distance') {
        // First click picks From, second picks To, a third starts a new pair
        if (distancePair.from === null || distancePair.to !== null) distancePair = { from: poi.id, to: null };
        else distancePair.to = poi.id;
        renderDistanceTool();
        saveState();

        const from = pois.find(p => p.id === distancePair.from);
        document.getElementById('map-tool-hint').textContent = distancePair.to === null ?
            `From ${from.name}: click the second POI` :
            `${from.name} → ${poi.name}: ${document.getElementById('distance-result').textContent}. Click a POI to start again`;
    }
}

function poiType(poi) {
    return POI_TYPES[poi.type] || POI_TYPES.poi;
}

function poiIcon(poi) {
    const type = poiType(poi);
    const svg = iconSvg(type.icon, type.color);
    return L.divIcon({
        className: 'poi-marker',
        html: type.pulse ? `<div class="target-pulse">${svg}</div>` : svg,
        iconSize: type.icon.size,
        iconAnchor: type.icon.anchor
    });
}

// Redraw a POI's marker after its name or type changed
function updatePoiMarker(poi) {
    poi.marker.options.exportAs = { kind: 'poi', name: poi.name, type: poi.type };
    poi.marker.setIcon(poiIcon(poi));
    scheduleLabels();
}

function poiTypeSelect(selected, select = document.createElement('select')) {
    Object.entries(POI_TYPES).forEach(([value, type]) => select.add(new Option(type.label, value)));
    select.value = selected;
    return select;
}

// Add a point of interest; extra holds saved details such as a target's confidence
function addPoi(position, name, type = 'poi', extra = {}) {
    poiCount++;
    type = type in POI_TYPES ? type : 'poi';
    const poi = {
        id: poiCount,
        name: name || `${POI_TYPES[type].label} ${poiCount}`,
        type,
        position,
        confidence: extra.confidence || null
    };

    poi.marker = L.marker(position, { icon: poiIcon(poi) }).addTo(poiLayer);
    poi.marker.on('click', () => onPoiClick(poi));
    updatePoiMarker(poi);

    pois.push(poi);
    renderPoiList();
    saveState();
    return poi;
}

function removePoi(id) {
    const poi = pois.find(p => p.id === id);
    if (!poi) return;
    poiLayer.removeLayer(poi.marker);
    pois = pois.filter(p => p.id !== id);
    if (poi === currentTarget) {
        currentTarget = null;
        triangulatedGeometry = null;
        targetStale = false;
    }
    renderPoiList();
    saveState();
}

// Parse "lat,lng" or "lat lng" into [lat, lng], or null if invalid
function parseCoords(text) {
    const parts = text.trim().split(/[\s,]+/);
    if (parts.length !== 2 || parts.some(p => p === '')) return null;

    const [lat, lng] = parts.map(Number);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    return [lat, lng];
}

// Add a POI from the name/coordinates form
function addPoiFromForm() {
    const nameInput = document.getElementById('poi-name');
    const coordsInput = document.getElementById('poi-coords');
    const coords = parseCoords(coordsInput.value);

    if (!coords) {
        alert('Invalid coordinates format. Use Lat,Lng format with valid ranges.');
        coordsInput.focus();
        return;
    }

    const [lat, lng] = coords;
    addPoi([lat, lng], nameInput.value.trim(), document.getElementById('poi-type').value);
    nameInput.value = '';
    coordsInput.value = '';
    map.panTo([lat, lng]);
}

// Commit text inputs that apply on change when Enter is pressed
function blurOnEnter(input) {
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') input.blur();
    });
}

// Distance tool: the two POIs picked, by id
let distancePair = { from: null, to: null };

// Show the distance and bearing between the two picked POIs, with a line on the map
function renderDistanceTool() {
    document.getElementById('distance-tool').hidden = pois.length < 2;
    ['from', 'to'].forEach(end => {
        if (!pois.some(p => p.id === distancePair[end])) distancePair[end] = null;
        const select = document.getElementById(`distance-${end}`);
        select.innerHTML = '';
        select.add(new Option(end === 'from' ? 'From…' : 'To…', ''));
        pois.forEach(poi => select.add(new Option(poi.name, poi.id)));
        select.value = distancePair[end] ?? '';
    });

    distanceLayer.clearLayers();
    scheduleLabels();
    const result = document.getElementById('distance-result');
    const from = pois.find(p => p.id === distancePair.from);
    const to = pois.find(p => p.id === distancePair.to);
    if (!from || !to || from === to) {
        result.textContent = '';
        return;
    }

    const km = calculateDistance(from.position, to.position);
    const bearing = calculateBearing(from.position, to.position);
    const text = `${formatDistance(km)} @ ${bearing.toFixed(1)}°`;
    result.textContent = text;
    L.polyline(greatCirclePath(from.position, bearing, km), {
            color: '#fcc419',
            weight: 2,
            opacity: 0.9,
            dashArray: '2 6'
        })
        .addTo(distanceLayer);
}

// Rebuild the POI list, marker popups, distance tool and target panel
function renderPoiList() {
    const list = document.getElementById('poi-list');
    list.innerHTML = '';
    document.getElementById('poi-empty').hidden = pois.length > 0;

    pois.forEach(poi => {
        poi.marker.unbindPopup();
        if (!activeTool) {
            poi.marker.bindPopup(`
                <b>${escapeHtml(poi.name)}</b> (${poiType(poi).label})<br>
                ${formatCoords(poi.position)}
                ${poi.confidence ? `<br>Confidence: ${poi.confidence}` : ''}
            `);
        }

        const item = document.createElement('div');
        item.className = 'poi-item';
        item.classList.toggle('current-target', poi === currentTarget);

        const locate = document.createElement('button');
        locate.type = 'button';
        locate.className = 'poi-locate';
        locate.title = 'Show on map';
        locate.innerHTML = iconSvg(poiType(poi).icon, poiType(poi).color);
        locate.addEventListener('click', () => {
            map.setView(poi.position, Math.max(map.getZoom(), 14));
            poi.marker.openPopup();
        });

        // Name, type and coordinates are editable in place
        const nameInput = textInput(poi.name, 'Name');
        nameInput.title = 'Edit and press Enter to rename this POI';
        blurOnEnter(nameInput);
        nameInput.addEventListener('change', () => {
            poi.name = nameInput.value.trim() || poi.name;
            updatePoiMarker(poi);
            renderPoiList();
            saveState();
        });

        const typeSelect = poiTypeSelect(poi.type);
        typeSelect.title = 'Symbol type';
        typeSelect.addEventListener('change', () => {
            poi.type = typeSelect.value;
            updatePoiMarker(poi);
            renderPoiList();
            saveState();
        });

        const coordsInput = textInput(formatCoords(poi.position), 'Lat,Lng');
        coordsInput.title = 'Edit and press Enter to move this POI';
        blurOnEnter(coordsInput);
        coordsInput.addEventListener('change', () => {
            const coords = parseCoords(coordsInput.value);
            if (!coords) {
                alert('Invalid coordinates format. Use Lat,Lng format with valid ranges.');
                coordsInput.value = formatCoords(poi.position);
                return;
            }
            poi.position = coords;
            poi.marker.setLatLng(coords);
            renderPoiList();
            saveState();
        });

        // Triangulated targets keep the confidence of their fix
        const info = document.createElement('span');
        info.className = 'poi-info';
        if (poi.confidence) {
            info.textContent = poi.confidence;
            info.style.color = CONFIDENCE_COLORS[poi.confidence];
            info.title = 'Confidence of the triangulation';
        }

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'icon-button danger-hover';
        removeButton.title = 'Remove POI';
        removeButton.textContent = '✕';
        removeButton.addEventListener('click', () => removePoi(poi.id));

        item.append(locate, nameInput, typeSelect, removeButton, coordsInput, info);
        list.appendChild(item);
    });

    renderDistanceTool();
    renderTargetPanel();
    scheduleLabels();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Add a vertex to the measurement in progress
function addMeasurePoint(latlng) {
    const point = [latlng.lat, latlng.lng];

    if (!currentMeasure) {
        currentMeasure = {
            points: [],
            layers: [],
            total: 0,
            line: L.polyline([], {
                color: '#fcc419',
                weight: 2,
                opacity: 0.9,
                dashArray: '6 6'
            }).addTo(measureLayer)
        };
        currentMeasure.layers.push(currentMeasure.line);
        measurements.push(currentMeasure.points);
    }

    const points = currentMeasure.points;
    const last = points[points.length - 1];

    // Ignore repeated clicks on the same spot (e.g. the clicks of a double-click)
    if (last && last[0] === point[0] && last[1] === point[1]) return;

    let legText = '';
    if (last) {
        const leg = calculateDistance(last, point);
        currentMeasure.total += leg;
        legText = `Last leg: ${formatDistance(leg)} @ ${calculateBearing(last, point).toFixed(1)}°`;
    }

    points.push(point);
    currentMeasure.line.addLatLng(point);

    const vertex = L.circleMarker(point, {
            radius: 4,
            color: '#fcc419',
            fillColor: '#fcc419',
            fillOpacity: 1,
            weight: 1
        })
        .addTo(measureLayer);
    currentMeasure.layers.push(vertex);
    scheduleLabels();
    saveState();

    document.getElementById('map-tool-hint').textContent = points.length === 1 ?
        'Click to add the next point' :
        `Total: ${formatDistance(currentMeasure.total)} | ${legText}`;
}

// Finish the measurement in progress; a single point is not a measurement, so drop it
function finishMeasurement() {
    if (currentMeasure && currentMeasure.points.length < 2) {
        currentMeasure.layers.forEach(layer => measureLayer.removeLayer(layer));
        measurements = measurements.filter(m => m !== currentMeasure.points);
        saveState();
    }
    currentMeasure = null;
    scheduleLabels();
}

function clearMeasurements() {
    measureLayer.clearLayers();
    currentMeasure = null;
    measurements = [];
    scheduleLabels();
    saveState();
    if (activeTool === 'measure') {
        document.getElementById('map-tool-hint').textContent = 'Click to add points, double-click or Esc to finish';
    }
}

map.on('click', e => {
    if (activeTool === 'poi') {
        // Uses the type picked in the POI form
        const type = document.getElementById('poi-type').value;
        const label = POI_TYPES[type].label;
        const name = prompt(`${label} name:`, `${label} ${poiCount + 1}`);
        if (name === null) return;
        addPoi([e.latlng.lat, e.latlng.lng], name.trim(), type);
    } else if (activeTool === 'measure') {
        addMeasurePoint(e.latlng);
    }
});

map.on('dblclick', () => {
    if (activeTool === 'measure') {
        finishMeasurement();
        document.getElementById('map-tool-hint').textContent = 'Measurement finished. Click to start a new one';
    }
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activeTool) setMapTool(null);
});

// Persist everything to localStorage so it survives a page refresh
const STORAGE_KEY = 'sigint-triangulation-state';

function buildState() {
    return {
        rows: receivers.map(({ enabled, name, position, bearing }) => ({ enabled, name, position, bearing })),
        reportTime: document.getElementById('report-time').value,
        reportSign: document.getElementById('report-sign').value,
        reportFreq: document.getElementById('report-freq').value,
        pois: pois.map(poi => ({
            name: poi.name,
            type: poi.type,
            position: poi.position,
            ...(poi.confidence && { confidence: poi.confidence })
        })),
        currentTarget: pois.indexOf(currentTarget), // -1 if none
        targetGeometry: triangulatedGeometry,
        distance: [distancePair.from, distancePair.to].map(id => pois.findIndex(p => p.id === id)),
        receiversOpen: document.getElementById('receiver-panel').open,
        measurements: measurements.filter(points => points.length >= 2),
        baseLayer: activeBaseLayer,
        view: {
            center: [map.getCenter().lat, map.getCenter().lng],
            zoom: map.getZoom()
        }
    };
}

function saveState() {
    if (restoring) return;

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildState()));
    } catch (error) {
        console.warn('Could not save state:', error);
    }
}

// Rebuild rows, POIs, measurements and the target from a state object
function applyState(state) {
    restoring = true;
    try {
        const savedBase = baseLayers[state.baseLayer];
        if (savedBase && state.baseLayer !== activeBaseLayer) {
            map.removeLayer(baseLayers[activeBaseLayer]);
            savedBase.addTo(map);
            activeBaseLayer = state.baseLayer;
        }

        document.getElementById('report-time').value = state.reportTime || '';
        document.getElementById('report-sign').value = state.reportSign || '';
        document.getElementById('report-freq').value = state.reportFreq || '';
        (state.rows || []).forEach(values => addReceiver(values));
        (state.pois || []).forEach(poi => addPoi(poi.position, poi.name, poi.type, poi));
        currentTarget = pois[state.currentTarget] || null;
        triangulatedGeometry = currentTarget ? state.targetGeometry || null : null;
        const [from, to] = (state.distance || []).map(index => pois[index]?.id ?? null);
        distancePair = { from: from ?? null, to: to ?? null };
        document.getElementById('receiver-panel').open = state.receiversOpen ?? receivers.length === 0;

        (state.measurements || []).forEach(points => {
            points.forEach(([lat, lng]) => addMeasurePoint(L.latLng(lat, lng)));
            finishMeasurement();
        });
        document.getElementById('map-tool-hint').textContent = '';

        // Sessions saved before targets were POIs only stored that a triangulation was done
        if (state.triangulated && state.currentTarget === undefined) {
            const data = receivers.filter(r => r.enabled).map(readReceiver);
            if (data.length >= 2 && data.every(d => d.position && isValidBearing(d.bearing))) {
                calculateIntersection(data, { silent: true });
            }
        }

        if (state.view) map.setView(state.view.center, state.view.zoom);
    } catch (error) {
        console.warn('Saved state was invalid:', error);
    } finally {
        restoring = false;
    }

    drawVectors();
    renderPoiList();
    saveState();
}

// Restore saved state; returns false if there was nothing to restore
function loadState() {
    let state;
    try {
        state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (error) {
        console.warn('Could not load saved state:', error);
        return false;
    }
    if (!state) return false;

    applyState(state);
    return true;
}

// Presets are the saved state as a JSON file, for sharing setups between people
const PRESET_FORMAT = 'sigint-triangulation-preset';

function exportPreset() {
    const preset = { format: PRESET_FORMAT, version: 1, ...buildState() };
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `triangulation-preset-${new Date().toISOString().slice(0,10)}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
}

async function importPreset(file) {
    let preset;
    try {
        preset = JSON.parse(await file.text());
    } catch (error) {
        alert('Could not read preset: the file is not valid JSON.');
        return;
    }
    if (!preset || preset.format !== PRESET_FORMAT) {
        alert('This file is not a SIGINT triangulation preset.');
        return;
    }
    if (!confirm('Importing replaces the current receivers, POIs and measurements. Continue?')) return;

    resetSession();
    applyState(preset);
}

// Ask for the map API key once and remember it; an empty entry removes it
function promptApiKey() {
    const entered = prompt('Map API key (leave empty to remove):', key);
    if (entered === null) return;

    key = entered.trim();
    try {
        if (key) localStorage.setItem(API_KEY_STORAGE_KEY, key);
        else localStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch (error) {
        console.warn('Could not save API key:', error);
    }
    darkMap.setUrl(cartoUrl());
}

// Add event listeners
document.getElementById('set-api-key').addEventListener('click', promptApiKey);
document.getElementById('add-receiver').addEventListener('click', () => {
    addReceiver();
    document.querySelector('#receiver-list .receiver-item:last-child input').focus();
});
document.getElementById('new-signal').addEventListener('click', newSignal);
document.getElementById('clear-all').addEventListener('click', clearAll);
document.getElementById('receiver-panel').addEventListener('toggle', saveState);
document.getElementById('open-receivers').addEventListener('click', () => {
    document.getElementById('receiver-panel').open = true;
    document.getElementById('add-receiver').click();
});
['from', 'to'].forEach(end => {
    document.getElementById(`distance-${end}`).addEventListener('change', e => {
        distancePair[end] = Number(e.target.value) || null;
        renderDistanceTool();
        saveState();
    });
});
document.getElementById('report-time').addEventListener('input', saveState);
document.getElementById('report-sign').addEventListener('input', saveState);
document.getElementById('report-freq').addEventListener('input', saveState);
map.on('moveend', saveState);
document.getElementById('process-data').addEventListener('click', processData);
document.getElementById('copy-map').addEventListener('click', copyMapImage);
document.getElementById('save-image').addEventListener('click', () => saveMapImage());
document.getElementById('copy-report').addEventListener('click', copyReport);
document.getElementById('export-preset').addEventListener('click', exportPreset);
document.getElementById('import-preset').addEventListener('click', () => document.getElementById('preset-file').click());
document.getElementById('preset-file').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = ''; // allow importing the same file again
    if (file) importPreset(file);
});
document.getElementById('poi-mode').addEventListener('click', () => setMapTool('poi'));
document.getElementById('measure-mode').addEventListener('click', () => setMapTool('measure'));
document.getElementById('distance-mode').addEventListener('click', () => setMapTool('distance'));
document.getElementById('clear-measure').addEventListener('click', clearMeasurements);
document.getElementById('add-poi').addEventListener('click', addPoiFromForm);
['poi-name', 'poi-coords'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') addPoiFromForm();
    });
});

poiTypeSelect('poi', document.getElementById('poi-type'));

// Restore the previous session, or start with two empty receivers
if (!loadState()) {
    document.getElementById('receiver-panel').open = true;
    addReceiver();
    addReceiver();
    renderPoiList();
}