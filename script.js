// 1. Configuración Real de Supabase
const SUPABASE_URL = 'https://afzevcxtdhoktzsjckie.supabase.co';
const SUPABASE_KEY = 'sb_publishable_T7vPHcunOH0prZbYeiJoew_n_viACXt';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

console.info('✅ Conexión establecida con el servidor de Supabase.');

// Early guard: ensure Leaflet loaded
if (typeof L === 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.innerHTML = `<div style="padding:20px;color:#333;background:#fff;border-radius:8px;margin:20px">Error: Leaflet no está cargado. Revisa tu conexión o incluye la librería localmente.</div>`;
        }
    });
    throw new Error('Leaflet (L) está indefinido — abortando inicialización');
}

// 2. Inicialización del Mapa
// Limitar vista al Perú y evitar zoom demasiado alejado
const PERU_BOUNDS = L.latLngBounds([[-18.5, -81.5], [1.5, -68.0]]);
const map = L.map('map', {
    zoomControl: false,
    minZoom: 4,
    maxZoom: 18,
    maxBounds: PERU_BOUNDS.pad(0.15),
    maxBoundsViscosity: 1.0
}).setView([-9.0, -75.0], 5);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Zoom abajo a la izquierda para no estorbar al buscador
L.control.zoom({ position: 'bottomleft' }).addTo(map);

const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function buildFotoHtmlLazy(url, width, extraStyle) {
    if (!url) return '';
    const w = width || 150;
    const style = `border-radius:8px;${extraStyle ? ' ' + extraStyle : ''}`;
    return `<img data-src="${url}" src="${IMG_PLACEHOLDER}" width="${w}" loading="lazy" style="${style}">`;
}

map.on('popupopen', function(e) {
    const el = e && e.popup && e.popup.getElement ? e.popup.getElement() : null;
    if (!el) return;
    const imgs = el.querySelectorAll('img[data-src]');
    imgs.forEach(img => {
        const src = img.getAttribute('data-src');
        if (src) img.src = src;
        img.removeAttribute('data-src');
    });
});

// Visualizar/windows legacy removed — UI simplificada con botones independientes

// --- BUSCADOR (GEOCODER) ---
let geocoder = null;
try {
    if (L.Control && L.Control.geocoder) {
        geocoder = L.Control.geocoder({
            defaultMarkGeocode: false,
            placeholder: "Busca una calle o lugar...",
            errorMessage: "No se encontró el lugar.",
            position: 'topleft'
        })
        .on('markgeocode', function(e) {
            const latlng = e.geocode.center;
            map.setView(latlng, 17);
            alert("¡Lugar encontrado! Ahora haz clic exacto con tu puntero negro.");
        })
        .addTo(map);
    } else {
        console.warn('Geocoder no disponible (L.Control.geocoder no encontrado).');
    }
} catch (err) {
    console.warn('Error inicializando geocoder:', err.message);
}

// --- COMPRESIÓN DE IMAGEN ---
async function comprimirImagen(archivo) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(archivo);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 1000; 
                let width = img.width;
                let height = img.height;
                if (width > MAX_WIDTH) {
                    height *= MAX_WIDTH / width;
                    width = MAX_WIDTH;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => { resolve(blob); }, 'image/jpeg', 0.7); 
            };
        };
    });
}

// 3. Capturar clic y abrir Modal
let ubicacionActual = null; // IMPORTANTE: Se inicia en null

// VARIABLES PARA GEOJSON Y PALETA
let provinciasLayer = null;
let provinciasGeoJSON = null;
let departamentosLayer = null;
let departamentosGeoJSON = null;
let paletaColores = [];
let asignacionesProvincia = {};
const COLOR_CONFIG_TABLE = 'macro_color_config';
const COLOR_CONFIG_ID = 1;
let colorSaveTimer = null;
let puntosData = []; // guardará puntos cargados desde supabase
let currentMode = ''; // modos: 'sedes'|'provincias'|'departamentos' | empty = ninguno
// LayerGroup para los marcadores de puntos (no se muestran hasta pulsar Sedes)
let puntosLayerGroup = L.layerGroup();
let sedesOverlayLayer = L.layerGroup();
let sedesOverlayVisible = false;
let puntosVisible = false;
let lastModeBeforeSedes = '';
let addMode = false;
let lastModeBeforeAdd = '';
let btnDeps = null;
let btnProvs = null;
let btnSedes = null;
let btnAnadir = null;
let btnResultados = null;
let resultadosLayerGroup = L.layerGroup();
let resultadosState = { type: 'departamentos', query: '', selected: '' };
let resultadosDataCache = null;
let resultadosPopup = null;
let resultadosPopupCloseBySelection = false;
let resultadosPanelOpen = false;

function loadColorConfigFromLocal() {
    const paleta = JSON.parse(localStorage.getItem('macro_colores') || '[]');
    const asignaciones = JSON.parse(localStorage.getItem('macro_prov_colors') || '{}');
    return { paleta, asignaciones };
}

function aplicarColoresSedesDesdeConfig() {
    Object.keys(asignacionesProvincia || {}).forEach(key => {
        if (key.startsWith('SEDE:')) {
            const name = key.replace('SEDE:', '');
            const cfg = asignacionesProvincia[key] || {};
            if (!SEDES[name]) SEDES[name] = { color: cfg.color || '#27ae60', deps: [] };
            if (cfg.color) SEDES[name].color = cfg.color;
        }
    });
}

async function cargarColoresGlobales() {
    const local = loadColorConfigFromLocal();
    try {
        const { data, error } = await _supabase
            .from(COLOR_CONFIG_TABLE)
            .select('paleta, asignaciones')
            .eq('id', COLOR_CONFIG_ID)
            .maybeSingle();

        if (error) throw error;

        if (data && (data.paleta || data.asignaciones)) {
            paletaColores = Array.isArray(data.paleta) ? data.paleta : (local.paleta || []);
            asignacionesProvincia = data.asignaciones || local.asignaciones || {};
        } else {
            paletaColores = local.paleta || [];
            asignacionesProvincia = local.asignaciones || {};
            if ((paletaColores && paletaColores.length) || Object.keys(asignacionesProvincia).length) {
                scheduleGuardarColores();
            }
        }
    } catch (e) {
        console.warn('No se pudo cargar colores globales, usando cache local.', e && e.message);
        paletaColores = local.paleta || [];
        asignacionesProvincia = local.asignaciones || {};
    }

    aplicarColoresSedesDesdeConfig();
}

async function guardarColoresGlobales() {
    const payload = {
        id: COLOR_CONFIG_ID,
        paleta: paletaColores || [],
        asignaciones: asignacionesProvincia || {},
        updated_at: new Date().toISOString()
    };

    try {
        const { error } = await _supabase
            .from(COLOR_CONFIG_TABLE)
            .upsert(payload, { onConflict: 'id' });
        if (error) throw error;
    } catch (e) {
        console.warn('No se pudo guardar colores globales, guardando solo cache local.', e && e.message);
    }

    localStorage.setItem('macro_colores', JSON.stringify(paletaColores || []));
    localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia || {}));
}

function scheduleGuardarColores() {
    if (colorSaveTimer) clearTimeout(colorSaveTimer);
    colorSaveTimer = setTimeout(() => {
        colorSaveTimer = null;
        guardarColoresGlobales();
    }, 400);
}

// GeoJSON embebido de ejemplo (simplificado). Reemplazar por uno real cuando se tenga.
const ejemploDepartamentos = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { NOMBRE: 'Departamento A', departamento: 'Departamento A' },
            geometry: { type: 'Polygon', coordinates: [[[ -77.1, -12.0 ], [ -77.0, -12.0 ], [ -77.0, -12.1 ], [ -77.1, -12.1 ], [ -77.1, -12.0 ]]] }
        },
        {
            type: 'Feature',
            properties: { NOMBRE: 'Departamento B', departamento: 'Departamento B' },
            geometry: { type: 'Polygon', coordinates: [[[ -77.04, -12.02 ], [ -76.95, -12.02 ], [ -76.95, -12.12 ], [ -77.04, -12.12 ], [ -77.04, -12.02 ]]] }
        }
    ]
};

const ejemploProvincias = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { NAME: 'Provincia 1', provincia: 'Provincia 1', departamento: 'Departamento A' },
            geometry: { type: 'Polygon', coordinates: [[[ -77.095, -12.005 ], [ -77.03, -12.005 ], [ -77.03, -12.055 ], [ -77.095, -12.055 ], [ -77.095, -12.005 ]]] }
        },
        {
            type: 'Feature',
            properties: { NAME: 'Provincia 2', provincia: 'Provincia 2', departamento: 'Departamento B' },
            geometry: { type: 'Polygon', coordinates: [[[ -77.02, -12.03 ], [ -76.96, -12.03 ], [ -76.96, -12.08 ], [ -77.02, -12.08 ], [ -77.02, -12.03 ]]] }
        }
    ]
};

// Sedes macroregional mapping y colores
const SEDES = {
    'Cusco': { color: '#27ae60', deps: ['Cusco','Apurímac','Madre de Dios','Puno'] },
    'Arequipa': { color: '#e74c3c', deps: ['Arequipa','Tacna','Moquegua'] },
    'Junín': { color: '#3498db', deps: ['Junín','Ayacucho','Pasco','Huancavelica','Huánuco'] },
    'San Martín': { color: '#f39c12', deps: ['San Martín','Ucayali','Amazonas'] },
    'Piura': { color: '#d6336c', deps: ['Piura','Cajamarca','Tumbes','Lambayeque','La Libertad'] },
    'Lima': { color: '#6f42c1', deps: ['Lima','Ica','Áncash'] },
    'Iquitos': { color: '#17a2b8', deps: ['Loreto'] }
};

function getSedeForDepartment(deptName) {
    if (!deptName) return null;
    for (const key of Object.keys(SEDES)) {
        const deps = SEDES[key].deps.map(d => String(d).toLowerCase());
        if (deps.includes(String(deptName).toLowerCase())) return key;
    }
    return null;
}

async function fetchGeoJSON(path) {
    try {
        const res = await fetch(path);
        if (!res.ok) return null;
        const json = await res.json();
        console.log('GeoJSON cargado:', path);
        return json;
    } catch (e) {
        console.warn('No se pudo cargar', path, e.message);
        return null;
    }
}

function aplicarSedes() {
    if (!departamentosLayer || !departamentosGeoJSON) return;
    departamentosLayer.eachLayer(layer => {
        const props = layer.feature && layer.feature.properties || {};
        const name = props.departamento || props.NOMBRE || props.NAME || null;
        const sede = getSedeForDepartment(name);
        if (sede) {
            const color = SEDES[sede].color;
            layer.setStyle({ fillColor: color, fillOpacity: 0.8, weight: 1 });
        } else {
            layer.setStyle({ fillColor: '#ffffff', fillOpacity: 0.08, weight: 1 });
        }
    });
}

function renderSedesOverlay() {
    sedesOverlayLayer.clearLayers();
    (puntosData || []).filter(p => p.estado === 'aprobado').forEach(p => {
        const fotoHtml = buildFotoHtmlLazy(p.foto_url, 150);
        const m = L.marker([p.latitud, p.longitud]).bindPopup(
            `<div style="text-align:center;"><b>${p.descripcion || 'Zona de Calistenia'}</b><br>${fotoHtml}</div>`
        );
        sedesOverlayLayer.addLayer(m);
    });
    if (!map.hasLayer(sedesOverlayLayer)) map.addLayer(sedesOverlayLayer);
    sedesOverlayVisible = true;
}

function clearSedesOverlay() {
    sedesOverlayLayer.clearLayers();
    if (map.hasLayer(sedesOverlayLayer)) map.removeLayer(sedesOverlayLayer);
    sedesOverlayVisible = false;
}

function closeAllTooltips() {
    if (departamentosLayer) departamentosLayer.eachLayer(l => l.closeTooltip && l.closeTooltip());
    if (provinciasLayer) provinciasLayer.eachLayer(l => l.closeTooltip && l.closeTooltip());
}

function updateAddButtonUI() {
    if (!btnAnadir) return;
    if (addMode) {
        btnAnadir.textContent = 'Cancelar';
        btnAnadir.title = 'Cancelar';
        btnAnadir.classList.add('active');
    } else {
        btnAnadir.textContent = 'Añadir';
        btnAnadir.title = 'Añadir Zona';
        btnAnadir.classList.remove('active');
    }
}

function showAllModeButtons() {
    [btnDeps, btnProvs, btnSedes, btnAnadir].forEach(b => {
        if (b) b.style.display = '';
    });
}

function showOnlyModeButton(activeBtn) {
    [btnDeps, btnProvs, btnSedes, btnAnadir].forEach(b => {
        if (!b) return;
        b.style.display = b === activeBtn ? '' : 'none';
    });
}

function showModeWithAddButton(activeBtn) {
    [btnDeps, btnProvs, btnSedes, btnAnadir].forEach(b => {
        if (!b) return;
        b.style.display = (b === activeBtn || b === btnAnadir) ? '' : 'none';
    });
}

function showModeWithAddAndSedesButtons(activeBtn) {
    [btnDeps, btnProvs, btnSedes, btnAnadir].forEach(b => {
        if (!b) return;
        const keep = b === activeBtn || b === btnAnadir || b === btnSedes;
        b.style.display = keep ? '' : 'none';
    });
}

function restoreModeAfterAdd() {
    if (lastModeBeforeAdd === 'departamentos') {
        if (btnDeps) btnDeps.classList.add('active');
        showModeWithAddAndSedesButtons(btnDeps);
        return;
    }
    if (lastModeBeforeAdd === 'provincias') {
        if (btnProvs) btnProvs.classList.add('active');
        showModeWithAddAndSedesButtons(btnProvs);
        return;
    }
    if (lastModeBeforeAdd === 'sedes_all' || lastModeBeforeAdd === 'sedes') {
        if (btnSedes) btnSedes.classList.add('active');
        showModeWithAddButton(btnSedes);
        return;
    }
    showAllModeButtons();
}

function setMode(m) {
    currentMode = m;
    [btnDeps, btnProvs, btnSedes].forEach(b => b && b.classList.remove('active'));
    if (m === 'departamentos' && btnDeps) btnDeps.classList.add('active');
    if (m === 'provincias' && btnProvs) btnProvs.classList.add('active');
    if (m === 'sedes' && btnSedes) btnSedes.classList.add('active');

    if (provinciasLayer) { map.removeLayer(provinciasLayer); provinciasLayer = null; }
    if (departamentosLayer) { map.removeLayer(departamentosLayer); departamentosLayer = null; }

    if (m === 'departamentos') {
        if (departamentosGeoJSON) {
            loadDepartamentosGeoJSON(departamentosGeoJSON);
            openDepartamentosPanel();
        } else {
            (async () => {
                const paths = ['peru_departamental_simple.geojson', 'data/peru_departamental_simple.geojson'];
                for (const p of paths) {
                    const geo = await fetchGeoJSON(p);
                    if (geo) { loadDepartamentosGeoJSON(geo); openDepartamentosPanel(); return; }
                }
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.geojson,application/geo+json,application/json';
                fileInput.style.display = 'none';
                document.body.appendChild(fileInput);
                fileInput.addEventListener('change', async (ev) => {
                    const f = ev.target.files && ev.target.files[0];
                    if (!f) {
                        alert('No se seleccionó archivo.');
                        document.body.removeChild(fileInput);
                        return;
                    }
                    try {
                        const text = await f.text();
                        const geo = JSON.parse(text);
                        if (geo && geo.features && geo.features.length > 0) {
                            loadDepartamentosGeoJSON(geo);
                            openDepartamentosPanel();
                        } else {
                            alert('Archivo seleccionado no parece contener un GeoJSON válido de departamentos.');
                        }
                    } catch (err) {
                        alert('Error leyendo GeoJSON: ' + err.message);
                    }
                    document.body.removeChild(fileInput);
                });
                fileInput.click();
            })();
        }
    } else if (m === 'provincias') {
        (async () => {
            const paths = ['peru_provincial_simple.geojson', 'data/peru_provincial_simple.geojson'];
            for (const p of paths) {
                const geo = await fetchGeoJSON(p);
                if (geo) { loadProvinciasGeoJSON(geo); openProvinciasPanel(); return; }
            }
            loadProvinciasGeoJSON(ejemploProvincias);
            openProvinciasPanel();
        })();
    } else if (m === 'sedes') {
        (async () => {
            const paths = ['peru_departamental_simple.geojson', 'data/peru_departamental_simple.geojson'];
            let loaded = false;
            for (const p of paths) {
                const geo = await fetchGeoJSON(p);
                if (geo) { loadDepartamentosGeoJSON(geo); loaded = true; break; }
            }
            if (!loaded) loadDepartamentosGeoJSON(ejemploDepartamentos);
            aplicarSedes();
        })();
    }
}

map.on('click', function(e) {
    // Comportamiento según modo: solo abrir modal en modo 'add' (añadir)
    if (currentMode === 'add' || addMode) {
        ubicacionActual = { lat: e.latlng.lat, lng: e.latlng.lng };
        const modal = document.getElementById('modal-formulario');
        if (modal) {
            modal.style.display = 'flex';
            document.getElementById('formulario-zona').reset();
            document.getElementById('nombre-archivo').textContent = 'Ningún archivo seleccionado';
            if (btnAnadir) btnAnadir.style.display = 'none';
        }
    } else {
        // en otros modos no abrimos modal al hacer click en el mapa
    }
});


// Cerrar Modal - Función global
function cerrarModal() {
    const modal = document.getElementById('modal-formulario');
    if (modal) {
        modal.style.display = 'none';
    }
    document.getElementById('formulario-zona').reset();
    document.getElementById('nombre-archivo').textContent = 'Ningún archivo seleccionado';
    // Si el usuario cierra el modal cancelando una acción de 'añadir', limpiamos estado
    if (addMode) {
        addMode = false;
        document.body.classList.remove('adding-mode');
        const ba = document.getElementById('btn-anadir');
        if (ba) { ba.textContent = 'Añadir'; ba.title = 'Añadir Zona'; ba.classList.remove('active'); }
        currentMode = lastModeBeforeAdd || '';
        if (typeof restoreModeAfterAdd === 'function') restoreModeAfterAdd();
    }
    if (btnAnadir) btnAnadir.style.display = '';
    // limpiar ubicacion actual para evitar reuso accidental
    ubicacionActual = null;
}

// Nota: el modal solo se cierra con la X o el boton Cancelar

// ========== GLOBAL COLOR AND SVG HELPERS ==========
// (Move these out of DOMContentLoaded so they're accessible everywhere)

function ensureSvgDefs() {
    const svg = document.querySelector('#map svg.leaflet-zoom-animated');
    if (!svg) { console.debug('ensureSvgDefs: map SVG not found'); return null; }
    let defs = svg.querySelector('defs');
    if (!defs) {
        console.debug('ensureSvgDefs: creating <defs> in map SVG');
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
}

function sanitizeId(str) {
    return String(str).replace(/[^a-z0-9_-]/gi, '_') + '_' + Date.now();
}

// create a linearGradient that visually splits the fill 50/50 (hard edge) horizontally
function addSplitPatternForFeature(layer, c1, c2) {
    try {
        const defs = ensureSvgDefs();
        if (!defs) return null;
        const id = sanitizeId((layer.feature && layer.feature.id) || (layer.feature && (layer.feature.properties && (layer.feature.properties.NOMBPROV || layer.feature.properties.NOMBRE))) || 'split');
        // remove existing with same id if present
        const existing = defs.querySelector('#' + id);
        if (existing) existing.remove();
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.setAttribute('id', id);
        grad.setAttribute('gradientUnits', 'objectBoundingBox');
        grad.setAttribute('x1', '0');
        grad.setAttribute('y1', '0');
        grad.setAttribute('x2', '1');
        grad.setAttribute('y2', '0');
        // stops to create hard edge at 50%
        const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', c1); s1.setAttribute('stop-opacity', '1');
        const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s2.setAttribute('offset', '50%'); s2.setAttribute('stop-color', c1); s2.setAttribute('stop-opacity', '1');
        const s3 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s3.setAttribute('offset', '50%'); s3.setAttribute('stop-color', c2); s3.setAttribute('stop-opacity', '1');
        const s4 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s4.setAttribute('offset', '100%'); s4.setAttribute('stop-color', c2); s4.setAttribute('stop-opacity', '1');
        grad.appendChild(s1); grad.appendChild(s2); grad.appendChild(s3); grad.appendChild(s4);
        defs.appendChild(grad);
        console.debug('addSplitPatternForFeature: created gradient', id, c1, c2);
        if (layer) layer._patternId = id;
        return id;
    } catch (e) {
        console.warn('addSplitPatternForFeature failed', e.message);
        return null;
    }
}

function removePatternForFeature(layer) {
    try {
        if (layer && layer._path) {
            layer._path.setAttribute('fill', '');
        }
        const defs = ensureSvgDefs();
        if (!defs) return;
        if (layer && layer._patternId) {
            console.debug('removePatternForFeature: removing pattern', layer._patternId);
            const g = defs.querySelector('#' + layer._patternId);
            if (g) g.remove();
            delete layer._patternId;
        }
    } catch (e) {
        // ignore
    }
}

// Try to apply a fill url to a layer's SVG path; if the path isn't available yet, retry a few times
function applyFillUrl(layer, pid, opts) {
    opts = opts || {};
    const maxRetries = 12;
    let tries = 0;
    function attempt() {
        tries++;
        try {
            if (layer && layer._path) {
                console.debug('applyFillUrl: applying', pid, 'attempt', tries);
                layer._path.setAttribute('fill', 'url(#' + pid + ')');
                if (opts.fillOpacity !== undefined) layer._path.setAttribute('fill-opacity', String(opts.fillOpacity));
                // also ensure stroke style via leaflet setStyle for consistency
                layer.setStyle({ color: opts.strokeColor || '#555', weight: opts.weight || 1 });
                return true;
            } else {
                console.debug('applyFillUrl: layer._path not ready, attempt', tries);
            }
        } catch (e) {
            console.warn('applyFillUrl error on attempt', tries, e && e.message);
        }
        if (tries < maxRetries) {
            setTimeout(attempt, 80);
        } else {
            // fallback: apply solid color via leaflet style
            console.warn('applyFillUrl: giving up after', tries, 'attempts. Falling back to solid color');
            try { layer.setStyle({ fillColor: (opts && opts.fallbackColor) || '#ffffff', fillOpacity: opts.fillOpacity || 0.55, color: opts.strokeColor || '#555', weight: opts.weight || 1 }); } catch (e) { console.error('applyFillUrl: fallback failed', e && e.message); }
        }
    }
    attempt();
}

function setAreaColor(name, type, colorObj) {
    // Aplica color a features coincidentes
    if (type === 'departamento' && departamentosLayer) {
        departamentosLayer.eachLayer(layer => {
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.NOMBDEP || props.departamento || props.NOMBRE || props.NAME;
            if (String(nm) === String(name)) {
                if (colorObj && colorObj.split && colorObj.color2) {
                    const pid = addSplitPatternForFeature(layer, colorObj.color, colorObj.color2);
                    if (pid) applyFillUrl(layer, pid, { fillOpacity: 0.55, strokeColor: '#111', weight: 2, fallbackColor: colorObj.color });
                } else {
                    removePatternForFeature(layer);
                    layer.setStyle({ fillColor: colorObj.color, fillOpacity: 0.55, color: '#111', weight: 2 });
                }
            }
        });
        // Además, propagar el color a las provincias que pertenezcan a ese departamento
        if (provinciasLayer) {
            provinciasLayer.eachLayer(pl => {
                const pp = pl.feature && pl.feature.properties || {};
                const provDept = pp.NOMBDEP || pp.departamento || pp.DEPARTAMENTO || pp.DEPARTAMEN || pp.DEP || null;
                if (provDept && String(provDept).toLowerCase() === String(name).toLowerCase()) {
                    const provName = pp.NOMBPROV || pp.provincia || pp.NOMBRE || pp.NAME || '';
                    if (colorObj && colorObj.split && colorObj.color2) {
                        const pid = addSplitPatternForFeature(pl, colorObj.color, colorObj.color2);
                        if (pid) applyFillUrl(pl, pid, { fillOpacity: 0.55, strokeColor: '#555', weight: 1, fallbackColor: colorObj.color });
                        if (provName) asignacionesProvincia[provName] = { color: colorObj.color, color2: colorObj.color2, split: true, nombre: provName };
                    } else {
                        removePatternForFeature(pl);
                        pl.setStyle({ fillColor: colorObj.color, fillOpacity: 0.55, color: '#555', weight: 1 });
                        if (provName) asignacionesProvincia[provName] = { color: colorObj.color, nombre: provName };
                    }
                }
            });
            scheduleGuardarColores();
        }
    }
    if (type === 'provincia' && provinciasLayer) {
        provinciasLayer.eachLayer(layer => {
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.NOMBPROV || props.provincia || props.NOMBRE || props.NAME;
            if (String(nm) === String(name)) {
                // soporte para doble color (gradiente)
                const split = colorObj && colorObj.split;
                if (split && colorObj.color2) {
                    // intentar aplicar un gradiente SVG
                    const pid = addSplitPatternForFeature(layer, colorObj.color, colorObj.color2);
                    if (pid) applyFillUrl(layer, pid, { fillOpacity: 0.55, strokeColor: '#555', weight: 1, fallbackColor: colorObj.color });
                } else {
                    // color único
                    // eliminar posible patrón previo
                    removePatternForFeature(layer);
                    layer.setStyle({ fillColor: colorObj.color, fillOpacity: 0.55, color: '#555', weight: 1 });
                }
            }
        });
    }
    if (type === 'sede' && departamentosLayer) {
        const deps = SEDES[name] && SEDES[name].deps || [];
        departamentosLayer.eachLayer(layer => {
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.departamento || props.NOMBRE || props.NAME;
            if (deps.map(d=>d.toLowerCase()).includes(String(nm).toLowerCase())) {
                layer.setStyle({ fillColor: colorObj.color, fillOpacity: 0.85 });
            }
        });
    }
}

// Inicializar UI de paleta y archivo
document.addEventListener('DOMContentLoaded', async function() {
    await cargarColoresGlobales();
    // Render paleta
    renderPaleta();

    // GeoJSON se carga bajo demanda cuando el usuario activa un modo

    const agregarBtn = document.getElementById('agregar-color');
    if (agregarBtn) agregarBtn.addEventListener('click', () => {
        const color = document.getElementById('color-input').value;
        const nombre = document.getElementById('color-nombre').value || color;
        paletaColores.push({ color, nombre });
        scheduleGuardarColores();
        renderPaleta();
        document.getElementById('color-nombre').value = '';
    });

    const geoInput = document.getElementById('geojson-file');
    if (geoInput) geoInput.addEventListener('change', async function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        try {
            const geo = JSON.parse(text);
            // Auto-detect tipo por propiedades del primer feature (sin pedir al usuario)
            if (geo && geo.features && geo.features.length > 0) {
                const props = geo.features[0].properties || {};
                const keys = Object.keys(props).map(k => k.toLowerCase());
                const isDept = keys.includes('departamento') || keys.includes('departam') || keys.includes('depart') || keys.includes('dpto');
                const isProv = keys.includes('provincia') || keys.includes('prov') || keys.includes('name') || keys.includes('nombre');
                if (isDept && !isProv) {
                    loadDepartamentosGeoJSON(geo);
                    alert('GeoJSON de departamentos cargado. Haz clic en un departamento para asignarle color.');
                } else {
                    loadProvinciasGeoJSON(geo);
                    alert('GeoJSON de provincias cargado. Haz clic en una provincia para asignarle color.');
                }
            } else {
                alert('GeoJSON inválido o sin features.');
            }
        } catch (err) {
            alert('Error al leer GeoJSON: ' + err.message);
        }
    });

    btnDeps = document.getElementById('btn-departamentos');
    btnProvs = document.getElementById('btn-provincias');
    btnSedes = document.getElementById('btn-sedes');
    btnAnadir = document.getElementById('btn-anadir');
    btnResultados = document.getElementById('btn-resultados');
    console.log('UI init: mode buttons?', !!btnDeps, !!btnProvs, !!btnSedes);

    // Función para limpiar completamente el mapa (sin sedes)
    function limpiarMapaCompleto() {
        // Limpiar capas geográficas
        if (provinciasLayer && map.hasLayer(provinciasLayer)) { map.removeLayer(provinciasLayer); provinciasLayer = null; }
        if (departamentosLayer && map.hasLayer(departamentosLayer)) { map.removeLayer(departamentosLayer); departamentosLayer = null; }
        
        // Cerrar paneles flotantes
        try { const dp = document.getElementById('win-departamentos-panel'); if (dp) dp.style.display = 'none'; } catch(e){}
        try { const pp = document.getElementById('win-provincias-panel'); if (pp) pp.style.display = 'none'; } catch(e){}
        
        // Limpiar TODOS los puntos
        puntosLayerGroup.clearLayers();
        if (map.hasLayer(puntosLayerGroup)) map.removeLayer(puntosLayerGroup);
        puntosVisible = false;
        currentMode = '';
        
        // Resetear textos de botones
        if (btnDeps) { btnDeps.textContent = 'Mapa Macroregional'; btnDeps.classList.remove('active'); }
        if (btnProvs) { btnProvs.textContent = 'Provincias'; btnProvs.classList.remove('active'); }
        if (btnSedes) { btnSedes.textContent = 'Sedes'; btnSedes.classList.remove('active'); }
        showAllModeButtons();
    }

    // Función para volver a la vista por defecto (sedes aprobadas)
    function volverVistaDefault() {
        // Limpiar capas geográficas
        if (provinciasLayer && map.hasLayer(provinciasLayer)) { map.removeLayer(provinciasLayer); provinciasLayer = null; }
        if (departamentosLayer && map.hasLayer(departamentosLayer)) { map.removeLayer(departamentosLayer); departamentosLayer = null; }
        
        // Cerrar paneles flotantes
        try { const dp = document.getElementById('win-departamentos-panel'); if (dp) dp.style.display = 'none'; } catch(e){}
        try { const pp = document.getElementById('win-provincias-panel'); if (pp) pp.style.display = 'none'; } catch(e){}
        
        // Mostrar solo puntos aprobados
        puntosLayerGroup.clearLayers();
        puntosData.filter(p => p.estado === 'aprobado').forEach(p => {
            const fotoHtml = buildFotoHtmlLazy(p.foto_url, 150);
            const m = L.marker([p.latitud, p.longitud]).bindPopup(`<div style="text-align:center;"><b>${p.descripcion || 'Zona de Calistenia'}</b><br>${fotoHtml}</div>`);
            puntosLayerGroup.addLayer(m);
        });
        
        if (!map.hasLayer(puntosLayerGroup)) map.addLayer(puntosLayerGroup);
        puntosVisible = true;
        currentMode = 'default';
        
        // Resetear textos de botones
        if (btnDeps) { btnDeps.textContent = 'Mapa Macroregional'; btnDeps.classList.remove('active'); }
        if (btnProvs) { btnProvs.textContent = 'Provincias'; btnProvs.classList.remove('active'); }
        if (btnSedes) { btnSedes.textContent = 'Sedes'; btnSedes.classList.remove('active'); }
        showAllModeButtons();
    }

    // iniciar sin mostrar ventanas legacy — ahora usamos botones independientes para cada modo
    // VISTA POR DEFECTO: mapa limpio (sin sedes)
    cargarPuntosAprobados().then(() => {
        setTimeout(() => limpiarMapaCompleto(), 500);
    });

    // Mode button handlers (replaces old Visualizar/windows flow)
    if (btnDeps) btnDeps.addEventListener('click', () => { 
        // disable add mode if active
        if (addMode) { addMode = false; document.body.classList.remove('adding-mode'); updateAddButtonUI(); }
            clearSedesOverlay();
            if (btnSedes) { btnSedes.textContent = 'Mostrar sedes'; btnSedes.classList.remove('active'); }
        
        // Si ya está activo (dice "Cancelar"), limpiar mapa completamente
        if (btnDeps.textContent === 'Cancelar') {
            limpiarMapaCompleto();
        } else {
            // Activar modo departamentos
            btnDeps.textContent = 'Cancelar';
            setMode('departamentos');
                showModeWithAddAndSedesButtons(btnDeps);
        }
    });
    if (btnProvs) btnProvs.addEventListener('click', () => { 
        if (addMode) { addMode = false; document.body.classList.remove('adding-mode'); updateAddButtonUI(); }
            clearSedesOverlay();
            if (btnSedes) { btnSedes.textContent = 'Mostrar sedes'; btnSedes.classList.remove('active'); }
        
        // Si ya está activo (dice "Cancelar"), limpiar mapa completamente
        if (btnProvs.textContent === 'Cancelar') {
            limpiarMapaCompleto();
        } else {
            // Activar modo provincias
            btnProvs.textContent = 'Cancelar';
            setMode('provincias');
                showModeWithAddAndSedesButtons(btnProvs);
        }
    });
    if (btnSedes) btnSedes.addEventListener('click', async () => {
            if (currentMode === 'departamentos' || currentMode === 'provincias') {
                if (sedesOverlayVisible) {
                    clearSedesOverlay();
                    btnSedes.textContent = 'Mostrar sedes';
                    btnSedes.classList.remove('active');
                } else {
                    renderSedesOverlay();
                    btnSedes.textContent = 'Quitar sedes';
                    btnSedes.classList.add('active');
                }
                return;
            }
        if (addMode) { addMode = false; document.body.classList.remove('adding-mode'); updateAddButtonUI(); }
        
        // Si ya está activo (dice "Cancelar"), volver a vista default (solo aprobados)
        if (btnSedes.textContent === 'Cancelar') {
            limpiarMapaCompleto();
        } else {
            // Activar modo: mostrar TODOS los puntos (aprobados + pendientes)
            // Limpiar capas geográficas
            if (provinciasLayer && map.hasLayer(provinciasLayer)) { map.removeLayer(provinciasLayer); provinciasLayer = null; }
            if (departamentosLayer && map.hasLayer(departamentosLayer)) { map.removeLayer(departamentosLayer); departamentosLayer = null; }
            
            // Cerrar paneles
            try { const dp = document.getElementById('win-departamentos-panel'); if (dp) dp.style.display = 'none'; } catch(e){}
            try { const pp = document.getElementById('win-provincias-panel'); if (pp) pp.style.display = 'none'; } catch(e){}
            
            // Mostrar TODOS los puntos (aprobados + pendientes)
            puntosLayerGroup.clearLayers();
            puntosData.forEach(p => {
                const fotoHtml = buildFotoHtmlLazy(p.foto_url, 150);
                if (p.estado === 'aprobado') {
                    const m = L.marker([p.latitud, p.longitud]).bindPopup(`<div style="text-align:center;"><b>${p.descripcion || 'Zona de Calistenia'}</b><br>${fotoHtml}</div>`);
                    puntosLayerGroup.addLayer(m);
                } else if (p.estado === 'pendiente') {
                    const m = L.marker([p.latitud, p.longitud], { opacity: 0.6, title: 'Pendiente de validación' })
                        .bindPopup(`<div style="text-align:center; opacity:0.9;"><b style="color:#f39c12;">⏳ ${p.descripcion || 'Esperando validación'}</b><br><small style="color:#666;">Subido por: ${p.nombre_persona}</small><br>${fotoHtml}<br><small style="color:#f39c12; font-weight:bold;">En revisión</small></div>`);
                    puntosLayerGroup.addLayer(m);
                }
            });
            
            if (!map.hasLayer(puntosLayerGroup)) map.addLayer(puntosLayerGroup);
            puntosVisible = true;
            currentMode = 'sedes_all';
            btnSedes.textContent = 'Cancelar';
            btnSedes.classList.add('active');
            showModeWithAddButton(btnSedes);
            
            // Resetear botones de departamentos/provincias
            if (btnDeps) { btnDeps.textContent = 'Mapa Macroregional'; btnDeps.classList.remove('active'); }
            if (btnProvs) { btnProvs.textContent = 'Provincias'; btnProvs.classList.remove('active'); }
        }
    });

    // Handler para el botón Añadir: activa modo para colocar pin (cursor chincheta)
    if (btnAnadir) btnAnadir.addEventListener('click', () => {
        addMode = !addMode;
        if (addMode) {
            // activar modo añadir
            document.body.classList.add('adding-mode');
            lastModeBeforeAdd = currentMode;
            currentMode = 'add';
            // desactivar otros botones visuales
            [btnDeps, btnProvs, btnSedes].forEach(b => b && b.classList.remove('active'));
            // cerrar paneles abiertos para no estorbar
            try { const dp = document.getElementById('win-departamentos-panel'); if (dp) dp.style.display = 'none'; } catch(e) {}
            try { const pp = document.getElementById('win-provincias-panel'); if (pp) pp.style.display = 'none'; } catch(e) {}
            closeAllTooltips();
            showOnlyModeButton(btnAnadir);
        } else {
            // desactivar modo añadir
            document.body.classList.remove('adding-mode');
            currentMode = lastModeBeforeAdd || '';
            restoreModeAfterAdd();
        }
        updateAddButtonUI();
    });

    if (btnResultados) btnResultados.addEventListener('click', async () => {
        await openResultadosPanel();
    });

});

function openColorEditor(name, type, parentEl) {
        // Evitar múltiples editores
        if (parentEl.querySelector('.fw-add')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'fw-add';
        wrapper.innerHTML = `<input type='color' value='#27ae60' class='fw-color'><input type='text' placeholder='Nombre del color' class='fw-color-name'><button class='btn-sm fw-assign'>Asignar</button>`;
        parentEl.appendChild(wrapper);
        const assignBtn = wrapper.querySelector('.fw-assign');
        assignBtn.addEventListener('click', () => {
            const color = wrapper.querySelector('.fw-color').value;
            const nombre = wrapper.querySelector('.fw-color-name').value || color;
            if (type === 'sede') {
                // actualizar SEDES mapping
                if (!SEDES[name]) SEDES[name] = { color, deps: [] };
                SEDES[name].color = color;
                asignacionesProvincia['SEDE:' + name] = { color, nombre };
            } else {
                const key = type === 'macro' ? 'MACRO:' + name : name;
                asignacionesProvincia[key] = { color, nombre };
            }
            scheduleGuardarColores();
            setAreaColor(name, type, { color, nombre });
            // actualizar UI
            renderPaleta();
            if (type === 'sede') aplicarSedes();
        });
    }

function renderPaleta() {
    const cont = document.getElementById('lista-colores');
    // Si el contenedor no existe (p. ej. en admin.html) no hacemos nada
    if (!cont) return;
    // Asegurar que la paleta esté inicializada
    paletaColores = paletaColores || [];
    cont.innerHTML = '';
    paletaColores.forEach((c, idx) => {
        const div = document.createElement('div');
        div.className = 'color-chip';
        div.innerHTML = `<div class='color-swatch' style='background:${c.color}'></div><div style='font-size:13px'>${c.nombre}</div><button class='color-erase' data-idx='${idx}'>X</button>`;
        cont.appendChild(div);
    });
    cont.querySelectorAll('.color-erase').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const i = Number(e.target.dataset.idx);
            paletaColores.splice(i,1);
            scheduleGuardarColores();
            renderPaleta();
        });
    });
}

// Cargar GeoJSON de provincias y preparar interacción
function loadProvinciasGeoJSON(geojson) {
    provinciasGeoJSON = geojson;
    if (provinciasLayer) { map.removeLayer(provinciasLayer); provinciasLayer = null; }

    function estilo(feature) {
        return getDefaultProvinciaStyle(feature);
    }

    provinciasLayer = L.geoJSON(geojson, {
        style: estilo,
        onEachFeature: function(feature, layer) {
            const nombre = feature.properties && (feature.properties.NOMBPROV || feature.properties.provincia || feature.properties.NOMBRE || feature.properties.NAME) || 'Provincia';
            layer.bindTooltip(nombre, {sticky:true});
            layer.on('click', function() {
                if (addMode || currentMode === 'add') return;
                // Abrir panel y enfocar la provincia seleccionada
                openProvinciasPanel();
                const nm = nombre;
                setTimeout(() => {
                    const inp = document.querySelector(`#win-provincias-body .prov-color-input[data-name='${nm}']`);
                    if (inp) { inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); inp.focus(); }
                }, 60);
            });
        }
    }).addTo(map);

    // centrar y limitar al cargar provincias (si las geometrías existen)
    const provBounds = provinciasLayer && provinciasLayer.getBounds && provinciasLayer.getBounds();
    if (provBounds && provBounds.isValid && !provBounds.isEmpty) {
        map.fitBounds(provBounds, { padding: [20, 20] });
        map.setMaxBounds(provBounds.pad(0.12));
    }
}

// Cargar GeoJSON de departamentos y preparar interacción
function loadDepartamentosGeoJSON(geojson) {
    departamentosGeoJSON = geojson;
    if (departamentosLayer) { map.removeLayer(departamentosLayer); departamentosLayer = null; }

    function estilo(feature) {
        return getDefaultDepartamentoStyle(feature);
    }

    departamentosLayer = L.geoJSON(geojson, {
        style: estilo,
        onEachFeature: function(feature, layer) {
            const nombre = feature.properties && (feature.properties.departamento || feature.properties.NOMBRE || feature.properties.NAME) || 'Departamento';
            layer.bindTooltip(nombre, {sticky:true});
            layer.on('click', function() {
                if (addMode || currentMode === 'add') return;
                // Abrir el panel y enfocar el departamento seleccionado para editar color
                openDepartamentosPanel();
                const nm = nombre;
                setTimeout(() => {
                    const inp = document.querySelector(`#win-departamentos-list .dep-color-input[data-name='${nm}']`);
                    if (inp) { inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); inp.focus(); }
                }, 60);
            });

            // Hover: highlight all departments in the same sede
            layer.on('mouseover', function() {
                if (currentMode !== 'sedes') return;
                const deptName = nombre;
                const sedeKey = getSedeForDepartment(deptName);
                if (!sedeKey) return;
                departamentosLayer.eachLayer(l => {
                    const p = l.feature && l.feature.properties || {};
                    const nm = p.departamento || p.NOMBRE || p.NAME;
                    const s = getSedeForDepartment(nm);
                    if (s === sedeKey) {
                        l.setStyle({ weight: 3, fillOpacity: 0.8 });
                    } else {
                        l.setStyle({ fillOpacity: 0.08 });
                    }
                });
            });
            layer.on('mouseout', function() {
                if (currentMode !== 'sedes') return;
                aplicarSedes();
            });
        }
    }).addTo(map);

    // centrar y limitar al cargar departamentos (si las geometrías existen)
    const depsBounds = departamentosLayer && departamentosLayer.getBounds && departamentosLayer.getBounds();
    if (depsBounds && depsBounds.isValid && !depsBounds.isEmpty) {
        map.fitBounds(depsBounds, { padding: [20, 20] });
        map.setMaxBounds(depsBounds.pad(0.12));
    }
}

// Panel lateral de Departamentos: lista con color pickers para asignar color a cada departamento
function openDepartamentosPanel() {
    let panel = document.getElementById('win-departamentos-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'win-departamentos-panel';
        panel.className = 'float-window';
        panel.style.top = '70px';
        panel.style.right = '20px';
        panel.style.width = '360px';
        panel.innerHTML = `
            <div class="fw-header">Departamentos <button id="close-dep-panel" style="background:none;border:none;color:white;font-weight:bold;">✕</button></div>
            <div class="fw-body" id="win-departamentos-body">
                <input type="search" id="dep-search" class="fw-search" placeholder="Buscar departamento...">
                <div id="win-departamentos-list"></div>
            </div>
        `;
        document.body.appendChild(panel);
        document.getElementById('close-dep-panel').addEventListener('click', () => { panel.style.display = 'none'; });
    }

    const body = document.getElementById('win-departamentos-body');
    const list = document.getElementById('win-departamentos-list');
    if (list) list.innerHTML = '';
    if (!departamentosGeoJSON || !departamentosGeoJSON.features) {
        body.innerHTML = '<div style="color:#666;">GeoJSON de departamentos no cargado.</div>';
        panel.style.display = 'block';
        return;
    }

    const features = departamentosGeoJSON.features.slice().sort((a,b) => {
        const na = (a.properties && (a.properties.NOMBDEP || a.properties.departamento || a.properties.NOMBRE || a.properties.NAME) || '').toLowerCase();
        const nb = (b.properties && (b.properties.NOMBDEP || b.properties.departamento || b.properties.NOMBRE || b.properties.NAME) || '').toLowerCase();
        return na.localeCompare(nb);
    });

    features.forEach(f => {
        const name = f.properties && (f.properties.NOMBDEP || f.properties.departamento || f.properties.NOMBRE || f.properties.NAME) || 'Departamento';
        const assigned = asignacionesProvincia[name] || {};
        const color = assigned.color || '#ffffff';
        const color2 = assigned.color2 || assigned.color || '#ffffff';
        const split = !!assigned.split;
        const row = document.createElement('div');
        row.className = 'fw-item';
        row.dataset.name = name;
        const swatchStyle = split ? `background:linear-gradient(90deg, ${color} 0% 50%, ${color2} 50% 100%)` : `background:${color}`;
        row.innerHTML = `<div style="display:flex;align-items:center;"><div class='swatch' style='${swatchStyle}; width:20px; height:20px; border-radius:6px; border:1px solid rgba(0,0,0,0.08);'></div><div style="margin-left:8px;">${name}</div></div>
            <div class='fw-actions'>
                <input type='color' class='dep-color-input' data-name='${name}' value='${color}'>
                <button class='dep-split-btn' title='Dividir color' style='margin-left:6px;padding:4px 6px;border-radius:6px;'>≋</button>
                <input type='color' class='dep-color2-input' data-name='${name}' value='${color2}' style='display:${split?"inline-block":"none"}; margin-left:6px;'>
            </div>`;
        if (list) list.appendChild(row); else body.appendChild(row);
    });

    // Handlers: primary color for departments
    document.querySelectorAll('#win-departamentos-list .dep-color-input').forEach(inp => {
        inp.addEventListener('input', (e) => {
            const nm = e.target.dataset.name;
            const col = e.target.value;
            const assigned = asignacionesProvincia[nm] || {};
            assigned.color = col;
            asignacionesProvincia[nm] = assigned;
            scheduleGuardarColores();
            if (assigned.split && assigned.color2) {
                setAreaColor(nm, 'departamento', { color: assigned.color, color2: assigned.color2, split: true, nombre: nm });
                const sw = document.querySelector(`#win-departamentos-list .fw-item[data-name='${nm}'] .swatch`);
                if (sw) sw.style.background = `linear-gradient(90deg, ${assigned.color} 0% 50%, ${assigned.color2} 50% 100%)`;
            } else {
                setAreaColor(nm, 'departamento', { color: col, nombre: nm });
                const sw = document.querySelector(`#win-departamentos-list .fw-item[data-name='${nm}'] .swatch`);
                if (sw) sw.style.background = col;
            }
        });
    });
    // Handlers: second color for departments
    document.querySelectorAll('#win-departamentos-list .dep-color2-input').forEach(inp => {
        inp.addEventListener('input', (e) => {
            const nm = e.target.dataset.name;
            const col2 = e.target.value;
            const assigned = asignacionesProvincia[nm] || {};
            assigned.color2 = col2;
            assigned.split = true;
            asignacionesProvincia[nm] = assigned;
            scheduleGuardarColores();
            setAreaColor(nm, 'departamento', { color: assigned.color || col2, color2: col2, split: true, nombre: nm });
            const sw = document.querySelector(`#win-departamentos-list .fw-item[data-name='${nm}'] .swatch`);
            if (sw) sw.style.background = `linear-gradient(90deg, ${assigned.color || col2} 0% 50%, ${col2} 50% 100%)`;
        });
    });
    // Handlers: split toggle button for departments
    document.querySelectorAll('#win-departamentos-list .dep-split-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const item = btn.closest('.fw-item');
            const nm = item && item.dataset && item.dataset.name;
            if (!nm) return;
            const assigned = asignacionesProvincia[nm] || {};
            assigned.split = !assigned.split;
            if (!assigned.color2) assigned.color2 = assigned.color || '#ffffff';
            asignacionesProvincia[nm] = assigned;
            scheduleGuardarColores();
            const c2inp = item.querySelector('.dep-color2-input');
            const c1inp = item.querySelector('.dep-color-input');
            const sw = item.querySelector('.swatch');
            if (assigned.split) {
                if (c2inp) c2inp.style.display = 'inline-block';
                // apply split to department and its provinces
                setAreaColor(nm, 'departamento', { color: assigned.color || (c1inp && c1inp.value) || '#ffffff', color2: assigned.color2, split: true, nombre: nm });
                if (sw) sw.style.background = `linear-gradient(90deg, ${assigned.color || '#ffffff'} 0% 50%, ${assigned.color2} 50% 100%)`;
            } else {
                if (c2inp) c2inp.style.display = 'none';
                // remove split and apply single color to department and provinces
                const layer = findDepartmentLayerByName(nm);
                removePatternForFeature(layer);
                setAreaColor(nm, 'departamento', { color: assigned.color || (c1inp && c1inp.value) || '#ffffff', nombre: nm });
                if (sw) sw.style.background = assigned.color || (c1inp && c1inp.value) || '#ffffff';
            }
        });
    });

    // helper to find department layer by name
    function findDepartmentLayerByName(name) {
        if (!departamentosLayer) return null;
        let found = null;
        departamentosLayer.eachLayer(l => {
            const pp = l.feature && l.feature.properties || {};
            const nm = pp.NOMBDEP || pp.departamento || pp.NOMBRE || pp.NAME || '';
            if (String(nm) === String(name)) found = l;
        });
        return found;
    }

    // Search filter
    const searchInput = document.getElementById('dep-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const q = (e.target.value || '').trim().toLowerCase();
            (document.querySelectorAll('#win-departamentos-list .fw-item') || []).forEach(it => {
                const nm = (it.dataset && it.dataset.name) || '';
                it.style.display = (!q || nm.toLowerCase().includes(q)) ? '' : 'none';
            });
        });
    }

    panel.style.display = 'block';
}

// Panel lateral de Provincias: lista con color pickers (similar al panel de departamentos)
function openProvinciasPanel() {
    let panel = document.getElementById('win-provincias-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'win-provincias-panel';
        panel.className = 'float-window';
        panel.style.top = '70px';
        panel.style.right = '20px';
        panel.style.width = '360px';
        panel.innerHTML = `
            <div class="fw-header">Provincias <button id="close-prov-panel" style="background:none;border:none;color:white;font-weight:bold;">✕</button></div>
            <div class="fw-body" id="win-provincias-body">
                <input type="search" id="prov-search" class="fw-search" placeholder="Buscar provincia...">
                <div id="win-provincias-list"></div>
            </div>
        `;
        document.body.appendChild(panel);
        document.getElementById('close-prov-panel').addEventListener('click', () => { panel.style.display = 'none'; });
    }

    const body = document.getElementById('win-provincias-body');
    const list = document.getElementById('win-provincias-list');
    if (list) list.innerHTML = '';
    if (!provinciasGeoJSON || !provinciasGeoJSON.features) {
        body.innerHTML = '<div style="color:#666;">GeoJSON de provincias no cargado.</div>';
        panel.style.display = 'block';
        return;
    }

    const features = provinciasGeoJSON.features.slice().sort((a,b) => {
        const na = (a.properties && (a.properties.NOMBPROV || a.properties.provincia || a.properties.NOMBRE || a.properties.NAME) || '').toLowerCase();
        const nb = (b.properties && (b.properties.NOMBPROV || b.properties.provincia || b.properties.NOMBRE || b.properties.NAME) || '').toLowerCase();
        return na.localeCompare(nb);
    });

    features.forEach(f => {
        const name = f.properties && (f.properties.NOMBPROV || f.properties.provincia || f.properties.NOMBRE || f.properties.NAME) || 'Provincia';
        const assigned = asignacionesProvincia[name] || {};
        const color = assigned.color || '#ffffff';
        const color2 = assigned.color2 || assigned.color || '#ffffff';
        const split = !!assigned.split;
        const row = document.createElement('div');
        row.className = 'fw-item';
        row.dataset.name = name;
        // swatch shows gradient if split
        const swatchStyle = split ? `background:linear-gradient(90deg, ${color} 0% 50%, ${color2} 50% 100%)` : `background:${color}`;
        row.innerHTML = `<div style="display:flex;align-items:center;"><div class='swatch' style='${swatchStyle}; width:20px; height:20px; border-radius:6px; border:1px solid rgba(0,0,0,0.08);'></div><div style="margin-left:8px;">${name}</div></div>
            <div class='fw-actions'>
                <input type='color' class='prov-color-input' data-name='${name}' value='${color}'>
                <button class='prov-split-btn' title='Dividir color' style='margin-left:6px;padding:4px 6px;border-radius:6px;'>≋</button>
                <input type='color' class='prov-color2-input' data-name='${name}' value='${color2}' style='display:${split?"inline-block":"none"}; margin-left:6px;'>
            </div>`;
        if (list) list.appendChild(row); else body.appendChild(row);
    });

    // Handlers: primary color
    document.querySelectorAll('#win-provincias-list .prov-color-input').forEach(inp => {
        inp.addEventListener('input', (e) => {
            const nm = e.target.dataset.name;
            const col = e.target.value;
            const assigned = asignacionesProvincia[nm] || {};
            assigned.color = col;
            // if split active keep color2
            asignacionesProvincia[nm] = assigned;
            scheduleGuardarColores();
            // apply either single color or gradient depending on split flag
            if (assigned.split && assigned.color2) {
                setAreaColor(nm, 'provincia', { color: assigned.color, color2: assigned.color2, split: true, nombre: nm });
                // update swatch to gradient
                const sw = document.querySelector(`#win-provincias-list .fw-item[data-name='${nm}'] .swatch`);
                if (sw) sw.style.background = `linear-gradient(90deg, ${assigned.color} 0% 50%, ${assigned.color2} 50% 100%)`;
            } else {
                setAreaColor(nm, 'provincia', { color: col, nombre: nm });
                const sw = document.querySelector(`#win-provincias-list .fw-item[data-name='${nm}'] .swatch`);
                if (sw) sw.style.background = col;
            }
        });
    });
    // Handlers: second color (for split)
    document.querySelectorAll('#win-provincias-list .prov-color2-input').forEach(inp => {
        inp.addEventListener('input', (e) => {
            const nm = e.target.dataset.name;
            const col2 = e.target.value;
            const assigned = asignacionesProvincia[nm] || {};
            assigned.color2 = col2;
            assigned.split = true;
            asignacionesProvincia[nm] = assigned;
            scheduleGuardarColores();
            setAreaColor(nm, 'provincia', { color: assigned.color || col2, color2: col2, split: true, nombre: nm });
            const sw = document.querySelector(`#win-provincias-list .fw-item[data-name='${nm}'] .swatch`);
            if (sw) sw.style.background = `linear-gradient(90deg, ${assigned.color || col2} 0% 50%, ${col2} 50% 100%)`;
        });
    });
    // Handlers: split toggle button
    document.querySelectorAll('#win-provincias-list .prov-split-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const item = btn.closest('.fw-item');
            const nm = item && item.dataset && item.dataset.name;
            if (!nm) return;
            const assigned = asignacionesProvincia[nm] || {};
            assigned.split = !assigned.split;
            if (!assigned.color2) assigned.color2 = assigned.color || '#ffffff';
            asignacionesProvincia[nm] = assigned;
            scheduleGuardarColores();
            const c2inp = item.querySelector('.prov-color2-input');
            const c1inp = item.querySelector('.prov-color-input');
            const sw = item.querySelector('.swatch');
            if (assigned.split) {
                if (c2inp) c2inp.style.display = 'inline-block';
                // apply gradient
                setAreaColor(nm, 'provincia', { color: assigned.color || (c1inp && c1inp.value) || '#ffffff', color2: assigned.color2, split: true, nombre: nm });
                if (sw) sw.style.background = `linear-gradient(90deg, ${assigned.color || '#ffffff'} 0% 50%, ${assigned.color2} 50% 100%)`;
            } else {
                if (c2inp) c2inp.style.display = 'none';
                // remove gradient and apply single color
                removePatternForFeature(findProvinceLayerByName(nm));
                setAreaColor(nm, 'provincia', { color: assigned.color || (c1inp && c1inp.value) || '#ffffff', nombre: nm });
                if (sw) sw.style.background = assigned.color || (c1inp && c1inp.value) || '#ffffff';
            }
        });
    });

    // helper to find province layer by name
    function findProvinceLayerByName(name) {
        if (!provinciasLayer) return null;
        let found = null;
        provinciasLayer.eachLayer(l => {
            const pp = l.feature && l.feature.properties || {};
            const nm = pp.NOMBPROV || pp.provincia || pp.NOMBRE || pp.NAME || '';
            if (String(nm) === String(name)) found = l;
        });
        return found;
    }

    // Search filter
    const provSearch = document.getElementById('prov-search');
    if (provSearch) {
        provSearch.addEventListener('input', (e) => {
            const q = (e.target.value || '').trim().toLowerCase();
            (document.querySelectorAll('#win-provincias-list .fw-item') || []).forEach(it => {
                const nm = (it.dataset && it.dataset.name) || '';
                it.style.display = (!q || nm.toLowerCase().includes(q)) ? '' : 'none';
            });
        });
    }

    panel.style.display = 'block';
}

function getDepartamentoFeatureName(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    return (props.NOMBDEP || props.departamento || props.NOMBRE || props.NAME || '').trim();
}

function getProvinciaFeatureName(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    return (props.NOMBPROV || props.provincia || props.NOMBRE || props.NAME || '').trim();
}

function normalizeKey(value) {
    return String(value || '').trim().toLowerCase();
}

function getDefaultDepartamentoStyle(feature) {
    const key = feature.properties && (feature.properties.NOMBDEP || feature.properties.departamento || feature.properties.NOMBRE || feature.properties.NAME) || feature.id || '';
    const asign = asignacionesProvincia[key];
    return {
        color: '#111',
        weight: 2,
        fillColor: asign ? asign.color : '#ffffff',
        fillOpacity: asign ? 0.55 : 0.08
    };
}

function getDefaultProvinciaStyle(feature) {
    const key = feature.properties && (feature.properties.NOMBPROV || feature.properties.provincia || feature.properties.NOMBRE || feature.properties.NAME) || feature.id || '';
    const asign = asignacionesProvincia[key];
    return {
        color: '#555',
        weight: 1,
        fillColor: asign ? asign.color : '#ffffff',
        fillOpacity: asign ? 0.55 : 0.1
    };
}

async function buildResultadosIndex() {
    const approved = (puntosData || []).filter(p => p.estado === 'aprobado');
    await ensureGeoJSONForDetection();

    const deptFeatures = (departamentosGeoJSON && departamentosGeoJSON.features) || [];
    const provFeatures = (provinciasGeoJSON && provinciasGeoJSON.features) || [];

    const deptIndex = new Map();
    const provIndex = new Map();

    deptFeatures.forEach(f => {
        const name = getDepartamentoFeatureName(f);
        if (!name) return;
        const key = normalizeKey(name);
        if (!deptIndex.has(key)) {
            deptIndex.set(key, { name, count: 0, points: [], provincias: new Map() });
        }
    });

    provFeatures.forEach(f => {
        const name = getProvinciaFeatureName(f);
        if (!name) return;
        const key = normalizeKey(name);
        if (!provIndex.has(key)) {
            provIndex.set(key, { name, count: 0, points: [], departamentos: new Map() });
        }
    });

    for (const p of approved) {
        let deptName = '';
        let provName = '';

        try {
            const detected = await detectarProvinciaDepartamento(p.latitud, p.longitud);
            deptName = detected.departamento || '';
            provName = detected.provincia || '';
        } catch (e) {
            // keep empty if detection fails
        }

        if (!deptName && p.departamento) deptName = String(p.departamento).trim();
        if (!provName && p.provincia) provName = String(p.provincia).trim();

        const deptKey = normalizeKey(deptName);
        const provKey = normalizeKey(provName);
        const deptItem = deptIndex.get(deptKey) || null;
        const provItem = provIndex.get(provKey) || null;

        if (deptItem) {
            deptItem.count += 1;
            deptItem.points.push(p);
        }
        if (provItem) {
            provItem.count += 1;
            provItem.points.push(p);
        }
        if (deptItem && provItem) {
            deptItem.provincias.set(provItem.name, (deptItem.provincias.get(provItem.name) || 0) + 1);
            provItem.departamentos.set(deptItem.name, (provItem.departamentos.get(deptItem.name) || 0) + 1);
        }
    }

    const departamentos = Array.from(deptIndex.values()).map(dep => ({
        name: dep.name,
        count: dep.count,
        points: dep.points,
        provincias: Array.from(dep.provincias.entries()).map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name))
    })).sort((a, b) => a.name.localeCompare(b.name));

    const provincias = Array.from(provIndex.values()).map(prov => ({
        name: prov.name,
        count: prov.count,
        points: prov.points,
        departamentos: Array.from(prov.departamentos.entries()).map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name))
    })).sort((a, b) => a.name.localeCompare(b.name));

    return {
        total: approved.length,
        deptCount: departamentos.length,
        provCount: provincias.length,
        departamentos,
        provincias
    };
}

function getResultadosColorStyle(type, name) {
    const assigned = asignacionesProvincia[name] || {};
    if (assigned.split && assigned.color2) {
        return `linear-gradient(90deg, ${assigned.color || '#d0d0d0'} 0% 50%, ${assigned.color2} 50% 100%)`;
    }
    return assigned.color || '#d0d0d0';
}

function clearResultadosHighlight() {
    if (departamentosLayer) {
        departamentosLayer.setStyle((feature) => getDefaultDepartamentoStyle(feature));
    }
    if (provinciasLayer) {
        provinciasLayer.setStyle((feature) => getDefaultProvinciaStyle(feature));
    }
}

function applyResultadosIdleView() {
    if (!resultadosPanelOpen) return;
    if (departamentosLayer) {
        departamentosLayer.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
    }
    if (provinciasLayer) {
        provinciasLayer.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
    }
}

function hideResultadosAreas() {
    if (departamentosLayer) {
        departamentosLayer.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
    }
    if (provinciasLayer) {
        provinciasLayer.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
    }
}

function findResultadosLayer(type, name) {
    const target = String(name || '');
    if (type === 'departamentos' && departamentosLayer) {
        let found = null;
        departamentosLayer.eachLayer(layer => {
            if (found) return;
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.NOMBDEP || props.departamento || props.NOMBRE || props.NAME || '';
            if (String(nm) === target) found = layer;
        });
        return found;
    }
    if (type === 'provincias' && provinciasLayer) {
        let found = null;
        provinciasLayer.eachLayer(layer => {
            if (found) return;
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.NOMBPROV || props.provincia || props.NOMBRE || props.NAME || '';
            if (String(nm) === target) found = layer;
        });
        return found;
    }
    return null;
}

function closeResultadosPopup() {
    if (resultadosPopup) {
        resultadosPopupCloseBySelection = true;
        resultadosPopup.remove();
        resultadosPopup = null;
        resultadosPopupCloseBySelection = false;
    }
}

function openResultadosPopup(type, item) {
    closeResultadosPopup();
    const layer = findResultadosLayer(type, item && item.name);
    if (!layer || !layer.getBounds) return;
    const center = layer.getBounds().getCenter();
    const html = `
        <div style="min-width:160px;">
            <div style="font-weight:bold; margin-bottom:4px;">${item.name}</div>
            <div style="font-size:12px; color:#555;">Sedes: ${item.count}</div>
        </div>
    `;
    resultadosPopup = L.popup({ closeButton: true, autoClose: true })
        .setLatLng(center)
        .setContent(html)
        .openOn(map);

    resultadosPopup.on('remove', () => {
        if (resultadosPopupCloseBySelection) return;
        if (resultadosState.selected) {
            resultadosState.selected = '';
            updateResultadosPanel();
            clearResultadosPins();
            applyResultadosIdleView();
        }
    });
}

async function highlightResultadoArea(type, name) {
    await ensureGeoJSONForDetection();

    if (type === 'departamentos' && !departamentosLayer && departamentosGeoJSON) {
        loadDepartamentosGeoJSON(departamentosGeoJSON);
    }
    if (type === 'provincias' && !provinciasLayer && provinciasGeoJSON) {
        loadProvinciasGeoJSON(provinciasGeoJSON);
    }

    clearResultadosHighlight();

    const assigned = asignacionesProvincia[name] || {};
    const highlightColor = assigned.color || '#e74c3c';

    if (type === 'departamentos' && provinciasLayer) {
        provinciasLayer.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
    }
    if (type === 'provincias' && departamentosLayer) {
        departamentosLayer.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
    }

    if (type === 'departamentos' && departamentosLayer) {
        departamentosLayer.eachLayer(layer => {
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.NOMBDEP || props.departamento || props.NOMBRE || props.NAME || '';
            if (String(nm) === String(name)) {
                layer.setStyle({
                    color: highlightColor,
                    weight: 4,
                    fillColor: highlightColor,
                    fillOpacity: 0.6,
                    opacity: 1
                });
            } else {
                layer.setStyle({
                    fillOpacity: 0,
                    opacity: 0,
                    weight: 0
                });
            }
        });
    }

    if (type === 'provincias' && provinciasLayer) {
        provinciasLayer.eachLayer(layer => {
            const props = layer.feature && layer.feature.properties || {};
            const nm = props.NOMBPROV || props.provincia || props.NOMBRE || props.NAME || '';
            if (String(nm) === String(name)) {
                layer.setStyle({
                    color: highlightColor,
                    weight: 3,
                    fillColor: highlightColor,
                    fillOpacity: 0.6,
                    opacity: 1
                });
            } else {
                layer.setStyle({
                    fillOpacity: 0,
                    opacity: 0,
                    weight: 0
                });
            }
        });
    }
}

function renderResultadosPins(points) {
    resultadosLayerGroup.clearLayers();
    (points || []).forEach(p => {
        const fotoHtml = buildFotoHtmlLazy(p.foto_url, 150);
        const m = L.marker([p.latitud, p.longitud]).bindPopup(
            `<div style="text-align:center;"><b>${p.descripcion || 'Zona de Calistenia'}</b><br>${fotoHtml}</div>`
        );
        resultadosLayerGroup.addLayer(m);
    });
    if (!map.hasLayer(resultadosLayerGroup)) map.addLayer(resultadosLayerGroup);
}

function clearResultadosPins() {
    resultadosLayerGroup.clearLayers();
    if (map.hasLayer(resultadosLayerGroup)) map.removeLayer(resultadosLayerGroup);
}

function updateResultadosPanel() {
    const panel = document.getElementById('win-resultados-panel');
    if (!panel) return;
    const summaryEl = panel.querySelector('#results-summary');
    const listEl = panel.querySelector('#results-list');
    const detailsEl = panel.querySelector('#results-details');
    const searchEl = panel.querySelector('#results-search');
    const data = resultadosDataCache || { total: 0, departamentos: [], provincias: [], deptCount: 0, provCount: 0 };

    if (summaryEl) {
        summaryEl.textContent = `Total sedes: ${data.total} | Departamentos: ${data.deptCount} | Provincias: ${data.provCount}`;
    }

    if (searchEl) {
        searchEl.placeholder = resultadosState.type === 'departamentos' ? 'Buscar departamento...' : 'Buscar provincia...';
        searchEl.value = resultadosState.query || '';
    }

    if (!listEl || !detailsEl) return;
    listEl.innerHTML = '';
    detailsEl.innerHTML = '';

    const items = resultadosState.type === 'departamentos' ? data.departamentos : data.provincias;
    const q = (resultadosState.query || '').toLowerCase();
    const filtered = (items || []).filter(it => !q || String(it.name).toLowerCase().includes(q));

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'results-empty';
        empty.textContent = 'Sin resultados.';
        listEl.appendChild(empty);
        clearResultadosPins();
        applyResultadosIdleView();
        return;
    }

    filtered.forEach(it => {
        const row = document.createElement('div');
        row.className = 'results-item';
        row.dataset.name = it.name;

        const name = document.createElement('span');
        name.textContent = it.name;

        const count = document.createElement('span');
        count.textContent = String(it.count);

        row.appendChild(name);
        row.appendChild(count);
        if (it.name === resultadosState.selected) row.classList.add('active');
        row.addEventListener('click', async () => {
            resultadosState.selected = it.name;
            updateResultadosPanel();
            renderResultadosPins(it.points || []);
            await highlightResultadoArea(resultadosState.type, it.name);
            openResultadosPopup(resultadosState.type, it);
        });
        listEl.appendChild(row);
    });

    const selectedItem = filtered.find(it => it.name === resultadosState.selected) || null;
    if (!selectedItem) {
        const hint = document.createElement('div');
        hint.className = 'results-empty';
        hint.textContent = 'Selecciona un item para ver detalles.';
        detailsEl.appendChild(hint);
        clearResultadosPins();
        applyResultadosIdleView();
        closeResultadosPopup();
        return;
    }

    const title = document.createElement('div');
    title.className = 'results-detail-title';
    title.textContent = selectedItem.name;
    detailsEl.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'results-detail-meta';
    meta.textContent = `Sedes: ${selectedItem.count}`;
    detailsEl.appendChild(meta);

    const colorRow = document.createElement('div');
    colorRow.className = 'results-detail-color';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = 'Color:';
    const swatch = document.createElement('span');
    swatch.className = 'results-swatch';
    swatch.style.background = getResultadosColorStyle(resultadosState.type, selectedItem.name);
    colorRow.appendChild(colorLabel);
    colorRow.appendChild(swatch);
    detailsEl.appendChild(colorRow);

    const subTitle = document.createElement('div');
    subTitle.className = 'results-subtitle';
    subTitle.textContent = resultadosState.type === 'departamentos' ? 'Provincias implicadas' : 'Departamentos implicados';
    detailsEl.appendChild(subTitle);

    const subList = document.createElement('div');
    subList.className = 'results-sublist';
    const subItems = resultadosState.type === 'departamentos' ? selectedItem.provincias : selectedItem.departamentos;
    (subItems || []).forEach(s => {
        const row = document.createElement('div');
        row.className = 'results-subitem';
        const n = document.createElement('span');
        n.textContent = s.name;
        const c = document.createElement('span');
        c.textContent = String(s.count);
        row.appendChild(n);
        row.appendChild(c);
        subList.appendChild(row);
    });
    detailsEl.appendChild(subList);
}

async function openResultadosPanel() {
    let panel = document.getElementById('win-resultados-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'win-resultados-panel';
        panel.className = 'float-window';
        panel.style.top = '70px';
        panel.style.right = '20px';
        panel.style.width = '360px';
        panel.innerHTML = `
            <div class="fw-header">Resultados <button id="close-resultados-panel" style="background:none;border:none;color:white;font-weight:bold;">X</button></div>
            <div class="fw-body" id="win-resultados-body">
                <div id="results-summary" class="results-summary"></div>
                <div class="results-tabs">
                    <button class="results-tab active" data-type="departamentos" type="button">Departamentos</button>
                    <button class="results-tab" data-type="provincias" type="button">Provincias</button>
                </div>
                <input type="search" id="results-search" class="fw-search" placeholder="Buscar...">
                <div id="results-list" class="results-list"></div>
                <div id="results-details" class="results-details"></div>
            </div>
        `;
        document.body.appendChild(panel);

        const closeBtn = panel.querySelector('#close-resultados-panel');
        if (closeBtn) closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
            resultadosPanelOpen = false;
            resultadosState.selected = '';
            resultadosState.query = '';
            clearResultadosPins();
            closeResultadosPopup();
            hideResultadosAreas();
        });

        const tabs = panel.querySelectorAll('.results-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                resultadosState.type = tab.dataset.type;
                resultadosState.query = '';
                resultadosState.selected = '';
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                updateResultadosPanel();
                closeResultadosPopup();
            });
        });

        const searchEl = panel.querySelector('#results-search');
        if (searchEl) {
            searchEl.addEventListener('input', (e) => {
                resultadosState.query = (e.target.value || '').trim();
                resultadosState.selected = '';
                updateResultadosPanel();
                closeResultadosPopup();
            });
        }
    }

    resultadosDataCache = await buildResultadosIndex();
    resultadosPanelOpen = true;
    updateResultadosPanel();
    panel.style.display = 'block';
}
// 4. Cargar Puntos Aprobados y Pendientes desde Supabase
async function cargarPuntosAprobados() {
    try {
        const { data, error } = await _supabase
            .from('macro_puntos')
            .select('*');

        if (error) {
            console.error('Error cargando puntos desde Supabase:', error);
            puntosData = [];
            return;
        }

        puntosData = data || [];
        console.log('Puntos cargados desde Supabase:', puntosData.length);
        
        // NO construir LayerGroup aquí, lo haremos en la vista default
    } catch (e) {
        console.error('Error en cargarPuntosAprobados:', e.message);
        puntosData = [];
    }
}

async function ensureGeoJSONForDetection() {
    const deptPaths = ['peru_departamental_simple.geojson', 'data/peru_departamental_simple.geojson'];
    const provPaths = ['peru_provincial_simple.geojson', 'data/peru_provincial_simple.geojson'];

    if (!departamentosGeoJSON) {
        for (const p of deptPaths) {
            const geo = await fetchGeoJSON(p);
            if (geo) { departamentosGeoJSON = geo; break; }
        }
    }
    if (!provinciasGeoJSON) {
        for (const p of provPaths) {
            const geo = await fetchGeoJSON(p);
            if (geo) { provinciasGeoJSON = geo; break; }
        }
    }
}

// Al enviar el formulario, si existe provinciasGeoJSON, detectar provincia/departamento
async function detectarProvinciaDepartamento(lat, lng) {
    await ensureGeoJSONForDetection();
    const pt = turf.point([lng, lat]);
    let provincia = null;
    let departamento = null;

    if (provinciasGeoJSON) {
        for (const feat of provinciasGeoJSON.features) {
            if (!feat.geometry) continue;
            try {
                if (turf.booleanPointInPolygon(pt, feat)) {
                    const props = feat.properties || {};
                    provincia = props.NOMBPROV || props.provincia || props.NAME || props.NOMBRE || null;
                    // Some province GeoJSONs include department info
                    departamento = props.NOMBDEP || props.departamento || props.DEPARTAMENTO || props.DEPARTAMEN || props.DEPART || departamento;
                    break;
                }
            } catch (e) { /* ignore geometry errors */ }
        }
    }

    if (!departamento && departamentosGeoJSON) {
        for (const feat of departamentosGeoJSON.features) {
            if (!feat.geometry) continue;
            try {
                if (turf.booleanPointInPolygon(pt, feat)) {
                    const props = feat.properties || {};
                    departamento = props.NOMBDEP || props.departamento || props.DEPARTAMENTO || props.DEPARTAMEN || props.DEPART || null;
                    break;
                }
            } catch (e) { /* ignore geometry errors */ }
        }
    }

    return { provincia, departamento };
}

// 5. Subir Foto a Supabase Storage
async function subirFoto(archivoOptimizado) {
    if (!archivoOptimizado) return '';
    try {
        const nombreArchivo = `parque_${Date.now()}.jpg`;
        
        const { data: uploadData, error: uploadError } = await _supabase.storage
            .from('fotos')
            .upload(nombreArchivo, archivoOptimizado);

        if (uploadError) {
            console.error('Error subiendo foto a Supabase:', uploadError);
            throw uploadError;
        }

        const { data: urlData } = _supabase.storage
            .from('fotos')
            .getPublicUrl(uploadData.path);

        const fotoUrlReal = urlData.publicUrl;
        console.log('Foto subida exitosamente:', fotoUrlReal);
        return fotoUrlReal;
    } catch (e) {
        console.error('subirFoto error:', e.message);
        return '';
    }
}

// 6. Manejo del Formulario (DOMContentLoaded para asegurar que existan los IDs)
document.addEventListener('DOMContentLoaded', function() {
    // Manejador del input de archivo
    const fotoInput = document.getElementById('foto');
    if (fotoInput) {
        fotoInput.addEventListener('change', function(e) {
            const archivo = e.target.files[0];
            const nombreArchivSpan = document.getElementById('nombre-archivo');
            
            if (archivo) {
                nombreArchivSpan.innerHTML = `
                    <span style="color: #27ae60; font-weight: bold;">✓ ${archivo.name}</span>
                    <br>
                    <small style="color: #999; margin-top: 5px; display: block;">${(archivo.size / 1024).toFixed(2)} KB</small>
                    <button type="button" style="margin-top: 10px; padding: 5px 10px; background: #e67e22; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85em;" onclick="cambiarImagen()">Cambiar imagen</button>
                `;
            } else {
                nombreArchivSpan.textContent = 'Ningún archivo seleccionado';
            }
        });
    }

    const form = document.getElementById('formulario-zona');
    if (form) {
        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            // VERIFICACIÓN DE SEGURIDAD PARA EVITAR EL ERROR DE NULL
            if (!ubicacionActual || !ubicacionActual.lat || !ubicacionActual.lng) {
                alert('❌ Error: No se detectó la ubicación.\n\nPor favor:\n1. Cierra esta ventana\n2. Haz clic exacto en el mapa donde desees registrar la zona\n3. Vuelve a llenar el formulario');
                return;
            }

            const btnEnviar = document.querySelector('.btn-confirmar');
            const archivo = document.getElementById('foto').files[0];
            
            if (!archivo) { 
                alert('⚠️ Selecciona una foto');
                return;
            }

            // Guardar datos Y COORDENADAS antes de cerrar el modal
            const descripcion = document.getElementById('descripcion').value;
            const persona = document.getElementById('persona').value;
            const lat = ubicacionActual.lat;
            const lng = ubicacionActual.lng;

            // Cerrar modal del formulario INMEDIATAMENTE
            cerrarModal();
            
            // Mostrar modal de carga INMEDIATAMENTE
            mostrarCarga();

            try {
                const imagenComprimida = await comprimirImagen(archivo);
                let urlFinal = null;

                // Intentar subir la foto; si falla, continuar sin abortar
                try {
                    urlFinal = await subirFoto(imagenComprimida);
                } catch (upErr) {
                    console.warn('Advertencia: la foto no se pudo subir, continuando sin foto.', upErr);
                    urlFinal = null;
                }

                // Antes de insertar, intentar detectar provincia/departamento
                const geoInfo = await detectarProvinciaDepartamento(lat, lng);

                // Construir objeto a insertar (incluye provincia/departamento aunque foto falle)
                const nuevo = {
                    latitud: lat,
                    longitud: lng,
                    nombre_persona: persona,
                    nombre_patrocinador: persona,
                    descripcion: descripcion,
                    tipo_anuncio: document.getElementById('tipoAnuncio').value,
                    estado: 'pendiente',
                    foto_url: urlFinal || null,
                    provincia: geoInfo.provincia || null,
                    departamento: geoInfo.departamento || null,
                    mensaje_adm: null,
                    sede: null,
                    created_at: new Date().toISOString()
                };

                try {
                    nuevo.sede = getSedeForDepartment(geoInfo.departamento) || null;
                } catch (e) {
                    nuevo.sede = null;
                }

                // Intentar insertar. Si falla y había foto, reintentar sin foto.
                let { data, error: insertError } = await _supabase.from('macro_puntos').insert([nuevo]);
                if (insertError) {
                    console.warn('Insert inicial falló:', insertError.message);
                    if (urlFinal) {
                        // reintentar sin la URL de la foto
                        nuevo.foto_url = null;
                        const retry = await _supabase.from('macro_puntos').insert([nuevo]);
                        if (retry.error) throw new Error('Supabase INSERT error after retry: ' + retry.error.message);
                    } else {
                        throw new Error('Supabase INSERT error: ' + insertError.message);
                    }
                }

                // Cambiar a check después de 1 segundo
                setTimeout(() => {
                    mostrarCheck();
                }, 1000);

                // Cerrar modal y agregar marcador después de 2.5 segundos
                setTimeout(() => {
                    cerrarModalExito();

                    // Agregar marcador semitransparente al mapa
                    agregarMarcadorPendiente(
                        lat,
                        lng,
                        descripcion,
                        persona,
                        urlFinal
                    );
                    // Recalcular sombreado si está activo
                    const chk = document.getElementById('pintar-departamentos');
                    if (chk && chk.checked) aplicarSombreadoDepartamentos(true);
                }, 2500);
            } catch (err) {
                cerrarModalExito();
                alert('❌ Error: ' + err.message);
            } finally {
                btnEnviar.disabled = false;
                btnEnviar.textContent = 'Enviar Registro';
            }
        });
    }
});

// Función para cambiar la imagen seleccionada
function cambiarImagen() {
    document.getElementById('foto').click();
}

// Función para mostrar el modal de carga (solo spinner)
function mostrarCarga() {
    const modalExito = document.getElementById('modal-exito');
    const spinnerCarga = document.getElementById('spinner-carga');
    const checkExito = document.getElementById('check-exito');
    
    modalExito.style.display = 'flex';
    spinnerCarga.style.display = 'block';
    checkExito.style.display = 'none';
}

// Función para mostrar el check (reemplaza el spinner)
function mostrarCheck() {
    const spinnerCarga = document.getElementById('spinner-carga');
    const checkExito = document.getElementById('check-exito');
    
    spinnerCarga.style.display = 'none';
    checkExito.style.display = 'block';
}

// Función para cerrar el modal de éxito
function cerrarModalExito() {
    const modalExito = document.getElementById('modal-exito');
    modalExito.style.display = 'none';
}

// Guardar ubicación y datos del último registro para el preview
let ultimoRegistro = {
    latitud: null,
    longitud: null,
    descripcion: null,
    nombre_persona: null,
    foto_url: null,
    marcador: null
};

// Función para agregar marcador de preview pendiente
function agregarMarcadorPendiente(latitud, longitud, descripcion, nombre_persona, foto_url) {
    const fotoHtml = buildFotoHtmlLazy(foto_url, 150, 'display:block; margin:10px auto;');
    // Crear marcador semitransparente y añadirlo al layer group de puntos
    const marcador = L.marker([latitud, longitud], { opacity: 0.6, title: 'Pendiente de validación' })
        .bindPopup(`<div style="text-align:center; opacity:0.9;"><b style="color:#f39c12;">⏳ ${descripcion}</b><br><small style="color:#666;">Subido por: ${nombre_persona}</small><br>${fotoHtml}<br><small style="color:#f39c12; font-weight:bold;">En revisión</small></div>`);

    puntosLayerGroup.addLayer(marcador);
    if (puntosVisible) {
        // si el usuario está viendo las sedes, mostrar en el mapa inmediatamente
        if (!map.hasLayer(puntosLayerGroup)) map.addLayer(puntosLayerGroup);
        marcador.openPopup();
    }

    // Guardar referencia del marcador
    ultimoRegistro = { latitud, longitud, descripcion, nombre_persona, foto_url, marcador };
}

// Aplicar sombreado de departamentos según cantidad de sedes (usa puntosData cargados)
function aplicarSombreadoDepartamentos(enabled) {
    if (!departamentosLayer && !provinciasLayer) return;
    const layerToUse = departamentosLayer || provinciasLayer;
    if (!enabled) {
        layerToUse.setStyle(function(feature){
            const asign = asignacionesProvincia[feature.properties && (feature.properties.provincia || feature.properties.NOMBRE || feature.properties.NAME || feature.properties.departamento)];
            return { fillColor: asign ? asign.color : '#ffffff', fillOpacity: asign ? 0.7 : 0.1 };
        });
        return;
    }

    // Contar sedes por departamento
    const counts = {};
    (puntosData || []).forEach(p => {
        const d = p.departamento || p.provincia || null;
        if (d) counts[d] = (counts[d] || 0) + 1;
    });

    // Obtener máximo para normalizar
    const max = Math.max(0, ...Object.values(counts));

    layerToUse.setStyle(function(feature){
        const props = feature.properties || {};
        const dept = props.departamento || props.DEPARTAMENTO || props.DEPARTAMEN || props.DEPART || props.PROVINCIA || null;
        const c = counts[dept] || 0;
        if (c > 0 && max > 0) {
            // escala HSL desde amarillo(0) a rojo(0) según proporción
            const ratio = c / max;
            const hue = 40 - Math.round(ratio * 40); // 40->0
            const color = `hsl(${hue},85%,55%)`;
            return { color:'#444', weight:1, fillColor: color, fillOpacity: 0.7 };
        }
        // fallback a color asignado o claro
        const key = props && (props.provincia || props.NOMBRE || props.NAME) || '';
        const asign = asignacionesProvincia[key];
        return { color:'#444', weight:1, fillColor: asign ? asign.color : '#ffffff', fillOpacity: asign ? 0.7 : 0.08 };
    });
}

cargarPuntosAprobados();
