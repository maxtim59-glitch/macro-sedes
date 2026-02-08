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
let paletaColores = JSON.parse(localStorage.getItem('macro_colores') || '[]');
let asignacionesProvincia = JSON.parse(localStorage.getItem('macro_prov_colors') || '{}');
let puntosData = []; // guardará puntos cargados desde supabase
let currentMode = ''; // modos: 'sedes'|'provincias'|'departamentos' | empty = ninguno
// LayerGroup para los marcadores de puntos (no se muestran hasta pulsar Sedes)
let puntosLayerGroup = L.layerGroup();
let puntosVisible = false;
let lastModeBeforeSedes = '';
let addMode = false;

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

map.on('click', function(e) {
    // Comportamiento según modo: solo abrir modal en modo 'add' (añadir)
    if (currentMode === 'add' || addMode) {
        ubicacionActual = { lat: e.latlng.lat, lng: e.latlng.lng };
        const modal = document.getElementById('modal-formulario');
        if (modal) {
            modal.style.display = 'flex';
            document.getElementById('formulario-zona').reset();
            document.getElementById('nombre-archivo').textContent = 'Ningún archivo seleccionado';
        }
    } else {
        // en otros modos no abrimos modal al hacer click en el mapa
    }
});

// Evitar que se abra el modal sin ubicación al hacer clic en otros elementos
document.addEventListener('click', function(e) {
    // Evitar abrir modal si no hay ubicación
    if (!ubicacionActual && e.target.id === 'modal-formulario') {
        e.target.style.display = 'none';
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
    }
    // limpiar ubicacion actual para evitar reuso accidental
    ubicacionActual = null;
}

// Cerrar modal cuando se presiona Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        cerrarModal();
    }
})

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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
document.addEventListener('DOMContentLoaded', function() {
    // Render paleta
    renderPaleta();

    // Intento de precargar GeoJSON de departamentos desde el archivo incluido (root) o carpeta data
    fetchGeoJSON('peru_departamental_simple.geojson').then(geo => {
        if (geo) {
            departamentosGeoJSON = geo;
            console.log('Departamentos GeoJSON precargado desde root.');
        } else {
            fetchGeoJSON('data/peru_departamental_simple.geojson').then(geo2 => {
                if (geo2) { departamentosGeoJSON = geo2; console.log('Departamentos GeoJSON precargado desde data/.'); }
            });
        }
    });

    // Intento de precargar GeoJSON de provincias (root y data)
    fetchGeoJSON('peru_provincial_simple.geojson').then(geo => {
        if (geo) {
            provinciasGeoJSON = geo;
            console.log('Provincias GeoJSON precargado desde root.');
        } else {
            fetchGeoJSON('data/peru_provincial_simple.geojson').then(geo2 => {
                if (geo2) { provinciasGeoJSON = geo2; console.log('Provincias GeoJSON precargado desde data/.'); }
            });
        }
    });

    const agregarBtn = document.getElementById('agregar-color');
    if (agregarBtn) agregarBtn.addEventListener('click', () => {
        const color = document.getElementById('color-input').value;
        const nombre = document.getElementById('color-nombre').value || color;
        paletaColores.push({ color, nombre });
        localStorage.setItem('macro_colores', JSON.stringify(paletaColores));
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

    const pintarDeptChk = document.getElementById('pintar-departamentos');
    if (pintarDeptChk) pintarDeptChk.addEventListener('change', function() {
        aplicarSombreadoDepartamentos(this.checked);
    });

    // Modos: botones (usar los botones principales en la UI)
    function setMode(m) {
        currentMode = m;
        [btnDeps, btnProvs, btnSedes].forEach(b => b && b.classList.remove('active'));
        if (m === 'departamentos') btnDeps && btnDeps.classList.add('active');
        if (m === 'provincias') btnProvs && btnProvs.classList.add('active');
        if (m === 'sedes') btnSedes && btnSedes.classList.add('active');

        // Limpiar capas existentes
        if (provinciasLayer) { map.removeLayer(provinciasLayer); provinciasLayer = null; }
        if (departamentosLayer) { map.removeLayer(departamentosLayer); departamentosLayer = null; }

        // Mostrar la capa correspondiente
        if (m === 'departamentos') {
            // Si ya tenemos geo cargado, simplemente aplicarlo y abrir panel
            if (departamentosGeoJSON) {
                loadDepartamentosGeoJSON(departamentosGeoJSON);
                openDepartamentosPanel();
            } else {
                // Intentar cargar desde varios lugares: root primero, luego carpeta data
                (async () => {
                    const paths = ['peru_departamental_simple.geojson', 'data/peru_departamental_simple.geojson'];
                    for (const p of paths) {
                        const geo = await fetchGeoJSON(p);
                        if (geo) {
                            loadDepartamentosGeoJSON(geo);
                            openDepartamentosPanel();
                            return;
                        }
                    }
                    // Si no existe el GeoJSON, solicitamos al usuario que lo cargue localmente (evita mostrar cuadros de ejemplo)
                    console.warn('GeoJSON de departamentos no encontrado en paths esperados. Solicitando carga local.');
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
                // fallback a ejemplo si no encontramos el GeoJSON oficial
                loadProvinciasGeoJSON(ejemploProvincias);
                openProvinciasPanel();
            })();
        } else if (m === 'sedes') {
            // Sedes usa departamentos y aplica agrupación y colores
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
    // Botones de modo (reemplazan la funcionalidad 'Visualizar')
    const btnDeps = document.getElementById('btn-departamentos');
    const btnProvs = document.getElementById('btn-provincias');
    const btnSedes = document.getElementById('btn-sedes');
    const btnAnadir = document.getElementById('btn-anadir');

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
        if (btnDeps) { btnDeps.textContent = 'Departamentos'; btnDeps.classList.remove('active'); }
        if (btnProvs) { btnProvs.textContent = 'Provincias'; btnProvs.classList.remove('active'); }
        if (btnSedes) { btnSedes.textContent = 'Sedes'; btnSedes.classList.remove('active'); }
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
            const fotoHtml = p.foto_url ? `<img src="${p.foto_url}" width="150px" style="border-radius:8px;">` : '';
            const m = L.marker([p.latitud, p.longitud]).bindPopup(`<div style="text-align:center;"><b>${p.descripcion || 'Zona de Calistenia'}</b><br>${fotoHtml}</div>`);
            puntosLayerGroup.addLayer(m);
        });
        
        if (!map.hasLayer(puntosLayerGroup)) map.addLayer(puntosLayerGroup);
        puntosVisible = true;
        currentMode = 'default';
        
        // Resetear textos de botones
        if (btnDeps) { btnDeps.textContent = 'Departamentos'; btnDeps.classList.remove('active'); }
        if (btnProvs) { btnProvs.textContent = 'Provincias'; btnProvs.classList.remove('active'); }
        if (btnSedes) { btnSedes.textContent = 'Sedes'; btnSedes.classList.remove('active'); }
    }

    // iniciar sin mostrar ventanas legacy — ahora usamos botones independientes para cada modo
    // CARGAR VISTA POR DEFECTO: Sedes aprobadas al iniciar
    cargarPuntosAprobados().then(() => {
        setTimeout(() => volverVistaDefault(), 500);
    });

    // Mode button handlers (replaces old Visualizar/windows flow)
    if (btnDeps) btnDeps.addEventListener('click', () => { 
        // disable add mode if active
        if (addMode) { addMode = false; document.body.classList.remove('adding-mode'); updateAddButtonUI(); }
        
        // Si ya está activo (dice "Cancelar"), limpiar mapa completamente
        if (btnDeps.textContent === 'Cancelar') {
            limpiarMapaCompleto();
        } else {
            // Activar modo departamentos
            btnDeps.textContent = 'Cancelar';
            setMode('departamentos');
        }
    });
    if (btnProvs) btnProvs.addEventListener('click', () => { 
        if (addMode) { addMode = false; document.body.classList.remove('adding-mode'); updateAddButtonUI(); }
        
        // Si ya está activo (dice "Cancelar"), limpiar mapa completamente
        if (btnProvs.textContent === 'Cancelar') {
            limpiarMapaCompleto();
        } else {
            // Activar modo provincias
            btnProvs.textContent = 'Cancelar';
            setMode('provincias');
        }
    });
    if (btnSedes) btnSedes.addEventListener('click', async () => {
        if (addMode) { addMode = false; document.body.classList.remove('adding-mode'); updateAddButtonUI(); }
        
        // Si ya está activo (dice "Cancelar"), volver a vista default (solo aprobados)
        if (btnSedes.textContent === 'Cancelar') {
            volverVistaDefault();
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
                const fotoHtml = p.foto_url ? `<img src="${p.foto_url}" width="150px" style="border-radius:8px;">` : '';
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
            
            // Resetear botones de departamentos/provincias
            if (btnDeps) { btnDeps.textContent = 'Departamentos'; btnDeps.classList.remove('active'); }
            if (btnProvs) { btnProvs.textContent = 'Provincias'; btnProvs.classList.remove('active'); }
        }
    });

    // Handler para el botón Añadir: activa modo para colocar pin (cursor chincheta)
    if (btnAnadir) btnAnadir.addEventListener('click', () => {
        addMode = !addMode;
        if (addMode) {
            // activar modo añadir
            document.body.classList.add('adding-mode');
            currentMode = 'add';
            // desactivar otros botones visuales
            [btnDeps, btnProvs, btnSedes].forEach(b => b && b.classList.remove('active'));
        } else {
            // desactivar modo añadir
            document.body.classList.remove('adding-mode');
            currentMode = '';
        }
        updateAddButtonUI();
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
    paletaColores = paletaColores || JSON.parse(localStorage.getItem('macro_colores') || '[]');
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
            localStorage.setItem('macro_colores', JSON.stringify(paletaColores));
            renderPaleta();
        });
    });
}

// Cargar GeoJSON de provincias y preparar interacción
function loadProvinciasGeoJSON(geojson) {
    provinciasGeoJSON = geojson;
    if (provinciasLayer) { map.removeLayer(provinciasLayer); provinciasLayer = null; }

    function estilo(feature) {
        const key = feature.properties && (feature.properties.NOMBPROV || feature.properties.provincia || feature.properties.NOMBRE || feature.properties.NAME) || feature.id || '';
        const asign = asignacionesProvincia[key];
        return {
            color: '#555',
            weight: 1,
            fillColor: asign ? asign.color : '#ffffff',
            fillOpacity: asign ? 0.55 : 0.1
        };
    }

    provinciasLayer = L.geoJSON(geojson, {
        style: estilo,
        onEachFeature: function(feature, layer) {
            const nombre = feature.properties && (feature.properties.NOMBPROV || feature.properties.provincia || feature.properties.NOMBRE || feature.properties.NAME) || 'Provincia';
            layer.bindTooltip(nombre, {sticky:true});
            layer.on('click', function() {
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
        const key = feature.properties && (feature.properties.NOMBDEP || feature.properties.departamento || feature.properties.NOMBRE || feature.properties.NAME) || feature.id || '';
        const asign = asignacionesProvincia[key];
        return {
            color: '#111',
            weight: 2,
            fillColor: asign ? asign.color : '#ffffff',
            fillOpacity: asign ? 0.55 : 0.08
        }; 
    }

    departamentosLayer = L.geoJSON(geojson, {
        style: estilo,
        onEachFeature: function(feature, layer) {
            const nombre = feature.properties && (feature.properties.departamento || feature.properties.NOMBRE || feature.properties.NAME) || 'Departamento';
            layer.bindTooltip(nombre, {sticky:true});
            layer.on('click', function() {
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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
            localStorage.setItem('macro_prov_colors', JSON.stringify(asignacionesProvincia));
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

// Al enviar el formulario, si existe provinciasGeoJSON, detectar provincia/departamento
async function detectarProvinciaDepartamento(lat, lng) {
    const pt = turf.point([lng, lat]);
    const fuentes = [];
    if (provinciasGeoJSON) fuentes.push({geo: provinciasGeoJSON, tipo: 'provincia'});
    if (departamentosGeoJSON) fuentes.push({geo: departamentosGeoJSON, tipo: 'departamento'});
    for (const fuente of fuentes) {
        for (const feat of fuente.geo.features) {
            if (feat.geometry) {
                try {
                    if (turf.booleanPointInPolygon(pt, feat)) {
                        const props = feat.properties || {};
                        const provincia = props.provincia || props.NAME || props.NOMBRE || null;
                        const departamento = props.departamento || props.DEPARTAMENTO || props.DEPARTAMEN || props.DEPART || null;
                        return { provincia, departamento };
                    }
                } catch (e) { /* ignore geometry errors */ }
            }
        }
    }
    return { provincia: null, departamento: null };
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
    const fotoHtml = foto_url ? `<img src="${foto_url}" width="150px" style="border-radius:8px; display:block; margin:10px auto;">` : '';
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