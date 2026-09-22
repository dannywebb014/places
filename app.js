import * as db from "./db.js";
import * as g from "./google.js";
import { SUGGEST_WHAT, SUGGEST_WHO, suggestionTypes, matchesWho, whoLabel } from "./suggest.js";

// ─── State ───────────────────────────────────────────────────────────
const state = {
  lists: [],
  places: [],
  filter: new Set(),      // list ids to show; empty means every list
  hideDone: false,
  view: "list",           // list | suggest | place | add | settings
  selectedId: null,       // saved place being viewed
  draft: null,            // unsaved place being added
  back: "list",           // where Back goes from a place or draft
  suggest: { what: "things", who: "anyone", results: [], at: null, loading: false },
};
const pins = new Map();   // place id -> marker
let suggestionPins = [];
let draftPin = null;
let mePin = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GREY = "#8c8a84";

// ─── Helpers ─────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, kind === "err" ? 5000 : 2600);
}
const fail = (what) => (err) => {
  console.error(what, err);
  toast(err instanceof g.LimitError ? err.message : `${what}: ${err.message}`, "err");
};

const listById = (id) => state.lists.find(l => l.id === id);
const colourOf = (place) => place.list_ids.map(listById).find(Boolean)?.colour || GREY;

function milesBetween(a, b) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtMiles = (m) => m < 0.1 ? "here" : m < 10 ? `${m.toFixed(1)} mi` : `${Math.round(m)} mi`;
const fmtDate = (iso) => iso ? new Date(`${iso}T12:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// Pixels of map hidden under the sheet on a phone; zero beside the side
// panel. Worked out from the size rather than measured, because the sheet is
// still animating when this is needed. Matches the heights in index.html.
const covered = () => innerWidth >= 860 ? 0
  : ({ peek: 170, half: 0.52 * innerHeight, full: 0.86 * innerHeight })[document.body.dataset.sheet];
const mapCentre = () => g.getMap()?.getCenter()?.toJSON() || { lat: 54.3, lng: -2.8 };
const shortArea = (address) => (address || "").split(",").slice(-3, -1).join(",").trim() || address || "";
const PRICE = { INEXPENSIVE: "£", MODERATE: "££", EXPENSIVE: "£££", VERY_EXPENSIVE: "££££" };

function factsHtml(p) {
  const out = [];
  if (p.rating) out.push(`<span class="fact star">★ ${p.rating.toFixed ? p.rating.toFixed(1) : p.rating}${p.rating_count ? ` <span style="color:var(--dim);font-weight:500">(${Number(p.rating_count).toLocaleString("en-GB")})</span>` : ""}</span>`);
  if (PRICE[p.price_level]) out.push(`<span class="fact">${PRICE[p.price_level]}</span>`);
  if (p.good_for_children === true) out.push(`<span class="fact yes">Good for kids</span>`);
  if (p.allows_dogs === true) out.push(`<span class="fact yes">Dogs welcome</span>`);
  if (p.allows_dogs === false) out.push(`<span class="fact">No dogs</span>`);
  return out.length ? `<div class="facts">${out.join("")}</div>` : "";
}

// ─── Sheet size (phones) ─────────────────────────────────────────────
const SIZES = ["peek", "half", "full"];
function setSheet(size) { document.body.dataset.sheet = size; }
function growSheet(min = "half") {
  if (SIZES.indexOf(document.body.dataset.sheet) < SIZES.indexOf(min)) setSheet(min);
}
(function sheetGestures() {
  const grab = $("grab");
  let y0 = null;
  grab.addEventListener("pointerdown", e => { y0 = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener("pointerup", e => {
    if (y0 === null) return;
    const dy = e.clientY - y0, i = SIZES.indexOf(document.body.dataset.sheet);
    y0 = null;
    if (Math.abs(dy) < 8) setSheet(i === 0 ? "half" : "peek");
    else setSheet(SIZES[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
  });
})();

// ─── Pins ────────────────────────────────────────────────────────────
function visiblePlaces() {
  return state.places.filter(p =>
    (!state.filter.size || p.list_ids.some(id => state.filter.has(id))) &&
    !(state.hideDone && p.done));
}

function renderPins() {
  pins.forEach(g.removePin);
  pins.clear();
  for (const p of visiblePlaces()) {
    const marker = g.addPin({ lat: p.lat, lng: p.lng, colour: colourOf(p), done: p.done, title: p.name, onClick: () => openPlace(p.id) });
    if (p.id === state.selectedId) marker.content.classList.add("selected");
    pins.set(p.id, marker);
  }
}

function renderSuggestionPins() {
  suggestionPins.forEach(g.removePin);
  suggestionPins = state.view === "suggest"
    ? state.suggest.results.filter(r => !savedFor(r)).map(r =>
        g.addPin({ lat: r.lat, lng: r.lng, colour: "var(--accent)", suggestion: true, title: r.name, onClick: () => openDraft(r, "suggest") }))
    : [];
}

function renderDraftPin() {
  g.removePin(draftPin);
  draftPin = null;
  if (state.view === "add" && state.draft) {
    draftPin = g.addPin({ lat: state.draft.lat, lng: state.draft.lng, colour: "var(--accent)", title: state.draft.name });
    draftPin.content.classList.add("draft");
  }
}

// ─── Filter chips ────────────────────────────────────────────────────
function renderChips() {
  const chips = $("chips");
  const all = document.createElement("button");
  all.className = `chip${state.filter.size ? "" : " on"}`;
  all.textContent = "All";
  all.onclick = () => { state.filter.clear(); refresh(); };
  const lists = state.lists.map(l => {
    const b = document.createElement("button");
    b.className = `chip${state.filter.has(l.id) ? " on" : ""}`;
    b.style.setProperty("--c", l.colour);
    b.innerHTML = `<span class="dot"></span>${esc(l.name)}`;
    b.onclick = () => { state.filter.has(l.id) ? state.filter.delete(l.id) : state.filter.add(l.id); refresh(); };
    return b;
  });
  const done = document.createElement("button");
  done.className = `chip${state.hideDone ? " on" : ""}`;
  done.textContent = state.hideDone ? "Hiding been" : "Hide been";
  done.onclick = () => { state.hideDone = !state.hideDone; refresh(); };
  chips.replaceChildren(all, ...lists, done);
}

// ─── Sheet views ─────────────────────────────────────────────────────
function renderHead() {
  const head = $("sheet-head");
  if (state.view === "list" || state.view === "suggest") {
    head.innerHTML = `<div class="tabs">
      <button class="tab ${state.view === "list" ? "on" : ""}" data-v="list">Our places</button>
      <button class="tab ${state.view === "suggest" ? "on" : ""}" data-v="suggest">Suggestions</button></div>`;
    head.querySelectorAll(".tab").forEach(b => b.onclick = () => { showView(b.dataset.v); growSheet(); });
  } else {
    const label = { list: "Our places", suggest: "Suggestions" }[state.back] || "Back";
    head.innerHTML = `<button class="back"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>${label}</button>`;
    head.querySelector(".back").onclick = () => showView(state.back);
  }
}

function showView(view) {
  state.view = view;
  if (view !== "place") state.selectedId = null;
  if (view !== "add") state.draft = null;
  refresh();
  $("sheet-body").scrollTop = 0;
}

function refresh() {
  renderChips();
  renderHead();
  renderPins();
  renderSuggestionPins();
  renderDraftPin();
  const body = $("sheet-body");
  ({ list: renderList, suggest: renderSuggest, place: renderPlace, add: renderAdd, settings: renderSettings })[state.view](body);
}

// ── Our places ──
function renderList(body) {
  const centre = mapCentre();
  const shown = visiblePlaces()
    .map(p => ({ p, miles: milesBetween(centre, p) }))
    .sort((a, b) => (a.p.done - b.p.done) || (a.miles - b.miles));
  if (!state.places.length) {
    body.innerHTML = `<p class="empty">No places yet. Search above to add your first one, or try <b>Suggestions</b>.</p>`;
    return;
  }
  if (!shown.length) {
    body.innerHTML = `<p class="empty">Nothing matches these filters.</p>`;
    return;
  }
  const been = shown.filter(x => x.p.done).length;
  body.innerHTML = `<p class="count">${shown.length} place${shown.length === 1 ? "" : "s"}${been ? ` · ${been} been` : ""} · nearest the map centre first</p>`;
  for (const { p, miles } of shown) {
    const row = document.createElement("div");
    row.className = `row${p.done ? " done" : ""}`;
    row.style.setProperty("--c", colourOf(p));
    const lists = p.list_ids.map(listById).filter(Boolean).map(l => l.name).join(", ");
    row.innerHTML = `<span class="dot"></span>
      <div class="txt"><div class="name"></div><div class="sub"></div></div>
      <div class="end">${p.done ? `<span class="been">✓ Been</span><br>` : ""}${fmtMiles(miles)}</div>`;
    row.querySelector(".name").textContent = p.name;
    row.querySelector(".sub").textContent = [p.type_label, lists].filter(Boolean).join(" · ");
    row.onclick = () => openPlace(p.id, "list");
    body.append(row);
  }
}

// ── A saved place ──
function openPlace(id, back) {
  const p = state.places.find(x => x.id === id);
  if (!p) return;
  if (back) state.back = back;
  else if (state.view === "list" || state.view === "suggest") state.back = state.view;
  state.view = "place";
  state.selectedId = id;
  state.draft = null;
  refresh();
  $("sheet-body").scrollTop = 0;
  growSheet();
  g.focusOn(p.lat, p.lng, 14, covered());
}

function renderPlace(body) {
  const p = state.places.find(x => x.id === state.selectedId);
  if (!p) return showView("list");
  body.innerHTML = `<div class="detail">
    <h2></h2><div class="kind"></div><div class="addr"></div>${factsHtml(p)}
    <div class="visit" id="visit"></div>
    <div class="label">Lists</div><div class="list-picks" id="picks"></div>
    <div class="label">Notes</div><textarea class="field" id="note" placeholder="Anything to remember, like what to order or to book ahead"></textarea>
    <div class="actions">
      <a class="btn wide" target="_blank" rel="noopener" href="${esc(g.appleMapsUrl(p))}">Apple Maps</a>
      <a class="btn wide" target="_blank" rel="noopener" href="${esc(g.googleMapsUrl(p))}">Google Maps</a>
      ${p.website ? `<a class="btn wide" target="_blank" rel="noopener" href="${esc(p.website)}">Website</a>` : ""}
    </div>
    <div class="actions"><button class="btn danger" id="delete">Remove from places.</button></div>
  </div>`;
  body.querySelector("h2").textContent = p.name;
  body.querySelector(".kind").textContent = p.type_label || "";
  body.querySelector(".addr").textContent = p.address || "";

  renderListPicks($("picks"), p.list_ids, async (ids) => {
    await save(p, { list_ids: ids });
  });

  const note = $("note");
  note.value = p.note || "";
  note.onchange = () => save(p, { note: note.value });

  renderVisit($("visit"), p);

  $("delete").onclick = async () => {
    if (!confirm(`Remove ${p.name} from places.?`)) return;
    try {
      await db.deletePlace(p.id);
      state.places = state.places.filter(x => x.id !== p.id);
      toast(`Removed ${p.name}`);
      showView(state.back === "suggest" ? "suggest" : "list");
    } catch (e) { fail("Couldn’t remove it")(e); }
  };
}

async function save(p, changes) {
  try {
    const updated = await db.updatePlace(p.id, changes);
    Object.assign(p, updated);
    return true;
  } catch (e) {
    fail("Couldn’t save")(e);
    return false;
  }
}

function renderVisit(box, p) {
  if (p.done) {
    box.innerHTML = `<div class="head"><div><span class="been">✓ Been</span> <span style="color:var(--muted)">${esc(fmtDate(p.visited_on))}</span></div>
      ${p.my_rating ? `<span class="stars small">${"★".repeat(p.my_rating)}${"☆".repeat(5 - p.my_rating)}</span>` : ""}</div>
      ${p.visit_note ? `<p style="margin:8px 0 0"></p>` : ""}
      <div class="actions" style="margin-top:10px"><button class="btn" id="edit-visit">Edit</button><button class="btn danger" id="undo-visit">Not been yet</button></div>`;
    if (p.visit_note) box.querySelector("p").textContent = p.visit_note;
    $("edit-visit").onclick = () => visitForm(box, p);
    $("undo-visit").onclick = async () => {
      if (await save(p, { done: false, visited_on: null, my_rating: null, visit_note: "" })) refresh();
    };
  } else {
    box.innerHTML = `<div class="head"><span style="color:var(--muted)">Not been yet</span><button class="btn good" id="mark">✓ Mark as been</button></div>`;
    $("mark").onclick = () => visitForm(box, p);
  }
}

function visitForm(box, p) {
  let rating = p.my_rating || 0;
  box.innerHTML = `<div class="visit-row"><label style="font-weight:600">When</label><input class="field" type="date" id="v-date"></div>
    <div class="visit-row"><label style="font-weight:600">Our rating</label><div class="stars" id="v-stars"></div></div>
    <textarea class="field" id="v-note" placeholder="How was it?"></textarea>
    <div class="actions"><button class="btn good wide" id="v-save">Save</button><button class="btn" id="v-cancel">Cancel</button></div>`;
  $("v-date").value = p.visited_on || todayIso();
  $("v-note").value = p.visit_note || "";
  const stars = $("v-stars");
  const drawStars = () => {
    stars.replaceChildren(...[1, 2, 3, 4, 5].map(n => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = n <= rating ? "on" : "";
      b.textContent = "★";
      b.setAttribute("aria-label", `${n} star${n > 1 ? "s" : ""}`);
      b.onclick = () => { rating = rating === n ? 0 : n; drawStars(); };
      return b;
    }));
  };
  drawStars();
  $("v-cancel").onclick = () => renderVisit(box, p);
  $("v-save").onclick = async () => {
    const ok = await save(p, { done: true, visited_on: $("v-date").value || todayIso(), my_rating: rating || null, visit_note: $("v-note").value });
    if (ok) { toast(`${p.name} marked as been`); refresh(); }
  };
}

function renderListPicks(el, selected, onChange) {
  const ids = new Set(selected);
  el.replaceChildren(...state.lists.map(l => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${ids.has(l.id) ? " on" : ""}`;
    b.style.setProperty("--c", l.colour);
    b.innerHTML = `<span class="dot"></span>${esc(l.name)}`;
    b.onclick = async () => {
      ids.has(l.id) ? ids.delete(l.id) : ids.add(l.id);
      b.classList.toggle("on", ids.has(l.id));
      await onChange([...ids]);
      renderPins();
    };
    return b;
  }));
}

// ── Adding a place ──
function savedFor(g0) {
  return g0.google_place_id && state.places.find(p => p.google_place_id === g0.google_place_id);
}

function openDraft(place, back, preselect = []) {
  const saved = savedFor(place);
  if (saved) return openPlace(saved.id, back);
  state.back = back;
  state.view = "add";
  state.selectedId = null;
  state.draft = { ...place, list_ids: preselect, note: "" };
  refresh();
  $("sheet-body").scrollTop = 0;
  growSheet();
  g.focusOn(place.lat, place.lng, 14, covered());
}

function renderAdd(body) {
  const d = state.draft;
  body.innerHTML = `<div class="detail">
    <h2></h2><div class="kind"></div><div class="addr"></div>${factsHtml(d)}
    <div class="label">Add to</div><div class="list-picks" id="picks"></div>
    <div class="label">Notes</div><textarea class="field" id="note" placeholder="Anything to remember"></textarea>
    <div class="actions"><button class="btn primary wide" id="save">Save place</button></div>
  </div>`;
  body.querySelector("h2").textContent = d.name;
  body.querySelector(".kind").textContent = d.type_label || "";
  body.querySelector(".addr").textContent = d.address || "";
  const saveBtn = $("save");
  const sync = () => { saveBtn.disabled = !d.list_ids.length; saveBtn.textContent = d.list_ids.length ? "Save place" : "Pick a list first"; };
  renderListPicks($("picks"), d.list_ids, (ids) => { d.list_ids = ids; sync(); });
  sync();
  $("note").oninput = (e) => { d.note = e.target.value; };
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const { list_ids, note, ...fields } = d;
      const row = await db.addPlace({ ...fields, list_ids, note });
      state.places.unshift(row);
      toast(`Saved ${row.name}`);
      openPlace(row.id);
    } catch (e) {
      fail("Couldn’t save it")(e);
      sync();
    }
  };
}

// ── Suggestions ──
function renderSuggest(body) {
  const s = state.suggest;
  body.innerHTML = `
    <div class="seg" id="what">${SUGGEST_WHAT.map(w => `<button data-k="${w.id}" class="${s.what === w.id ? "on" : ""}">${w.label}</button>`).join("")}</div>
    <div class="seg" id="who">${SUGGEST_WHO.map(w => `<button data-k="${w.id}" class="${s.who === w.id ? "on" : ""}">${w.label}</button>`).join("")}</div>
    <button class="btn primary" style="width:100%" id="go">${s.loading ? "Looking…" : "Suggest around the map centre"}</button>
    <p class="hint">Each look uses one of today’s 25 Google searches.</p>
    <div id="suggest-results"></div>`;
  body.querySelectorAll("#what button").forEach(b => b.onclick = () => { s.what = b.dataset.k; renderSuggest(body); });
  body.querySelectorAll("#who button").forEach(b => b.onclick = () => { s.who = b.dataset.k; renderSuggest(body); });
  $("go").disabled = s.loading;
  $("go").onclick = runSuggest;

  const out = $("suggest-results");
  if (!s.at) return;
  if (!s.results.length) { out.innerHTML = `<p class="empty">Nothing found here. Try moving or zooming the map out.</p>`; return; }
  const good = s.results.filter(r => matchesWho(r, s.who));
  const rest = s.results.filter(r => !matchesWho(r, s.who));
  const section = (title, items) => {
    if (!items.length) return;
    if (title) out.insertAdjacentHTML("beforeend", `<div class="section-label">${title}</div>`);
    for (const r of items) {
      const saved = savedFor(r);
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div class="txt"><div class="name"></div><div class="sub"></div>${factsHtml(r)}</div>
        ${saved ? `<span class="saved-tag">✓ Saved</span>` : `<button class="add-btn">+ Add</button>`}`;
      row.querySelector(".name").textContent = r.name;
      row.querySelector(".sub").textContent = [r.type_label, fmtMiles(milesBetween(s.at, r))].filter(Boolean).join(" · ");
      row.onclick = () => saved ? openPlace(saved.id, "suggest") : openDraft(r, "suggest", defaultListsFor(s));
      out.append(row);
    }
  };
  if (s.who === "anyone") section("", good);
  else {
    section(good.length ? whoLabel(s.who) : "", good);
    section(good.length ? "Not confirmed by Google" : `Google hasn’t confirmed any of these as ${whoLabel(s.who).toLowerCase()}`, rest);
  }
}

function defaultListsFor(s) {
  const byName = (n) => state.lists.find(l => l.name.toLowerCase() === n)?.id;
  const ids = [s.what === "food" ? byName("restaurants") : byName("things to do")];
  if (s.who === "oscar") ids.push(byName("oscar"));
  if (s.who === "taco") ids.push(byName("taco"));
  return ids.filter(Boolean);
}

async function runSuggest() {
  const s = state.suggest;
  const map = g.getMap();
  const centre = mapCentre();
  const ne = map.getBounds()?.getNorthEast()?.toJSON();
  const radius = ne ? milesBetween(centre, ne) * 1609 * 0.75 : 5000;
  s.loading = true;
  renderSuggest($("sheet-body"));
  try {
    s.results = await g.searchNearby({ center: centre, radius, types: suggestionTypes(s.what, s.who) });
    s.at = centre;
    growSheet();
  } catch (e) {
    fail("Couldn’t get suggestions")(e);
  } finally {
    s.loading = false;
    if (state.view === "suggest") refresh();
  }
}

// ── Settings ──
async function renderSettings(body) {
  body.innerHTML = `
    <div class="label" style="margin-top:4px">Google usage</div>
    <div class="usage" id="usage">Checking…</div>
    <p class="hint">Adding a place or looking for suggestions uses one Google request. places. stops at 25 a day and 700 a month to stay inside Google’s free 1,000 a month.</p>
    <div class="label">Lists</div><div id="list-edit"></div>
    <div class="actions"><button class="btn" id="add-list">+ New list</button></div>
    <div class="label">Account</div>
    <p class="hint" id="who-am-i"></p>
    <div class="actions"><button class="btn" id="sign-out">Sign out</button></div>`;
  $("add-list").onclick = async () => {
    const name = prompt("Name of the new list");
    if (!name?.trim()) return;
    const palette = ["#d0633a", "#3d7fc4", "#2f8a84", "#9a6a3a", "#c2417a", "#7d6fd6", "#5b8a3a", "#c9a227", "#4a5a8a"];
    const colour = palette[state.lists.length % palette.length];
    try {
      state.lists.push(await db.addList(name.trim(), colour, state.lists.length));
      refresh();
    } catch (e) { fail("Couldn’t add the list")(e); }
  };
  $("sign-out").onclick = async () => { await db.signOut(); location.reload(); };
  const session = await db.getSession();
  $("who-am-i").textContent = session ? `Signed in as ${session.user.email}` : "";

  const edit = $("list-edit");
  edit.replaceChildren(...state.lists.map(l => {
    const row = document.createElement("div");
    row.className = "list-edit";
    row.innerHTML = `<input type="color" aria-label="Colour"><input class="field" type="text" aria-label="List name"><button class="btn danger" aria-label="Delete list">Delete</button>`;
    const [colour, name] = row.querySelectorAll("input");
    colour.value = l.colour;
    name.value = l.name;
    const update = async (changes) => {
      try { Object.assign(l, await db.updateList(l.id, changes)); renderChips(); renderPins(); }
      catch (e) { fail("Couldn’t update the list")(e); }
    };
    colour.onchange = () => update({ colour: colour.value });
    name.onchange = () => name.value.trim() && update({ name: name.value.trim() });
    row.querySelector("button").onclick = async () => {
      const using = state.places.filter(p => p.list_ids.includes(l.id));
      if (!confirm(`Delete the ${l.name} list?${using.length ? ` Its ${using.length} place${using.length === 1 ? "" : "s"} stay saved, just not on this list.` : ""}`)) return;
      try {
        for (const p of using) await db.updatePlace(p.id, { list_ids: p.list_ids.filter(id => id !== l.id) }).then(u => Object.assign(p, u));
        await db.deleteList(l.id);
        state.lists = state.lists.filter(x => x.id !== l.id);
        state.filter.delete(l.id);
        refresh();
      } catch (e) { fail("Couldn’t delete the list")(e); }
    };
    return row;
  }));

  try {
    const { today, month } = await db.googleUsage();
    $("usage").innerHTML = `<b>${today}</b> of 25 today · <b>${month}</b> of 700 this month
      <div class="meter"><span style="width:${Math.min(100, (month / 700) * 100)}%"></span></div>`;
  } catch (e) { $("usage").textContent = "Couldn’t check usage."; }
}

// ─── Search bar ──────────────────────────────────────────────────────
function setupSearch() {
  const input = $("search");
  const box = $("results");
  let timer, seq = 0, items = [], hl = -1;

  const close = () => { box.hidden = true; hl = -1; };
  const choose = async (item) => {
    close();
    input.value = "";
    input.blur();
    if (item.saved) return openPlace(item.saved.id, "list");
    const already = state.places.find(p => p.google_place_id === item.id);
    if (already) return openPlace(already.id, "list");
    try {
      const place = await g.placeFromSuggestion(item);
      openDraft(place, state.view === "suggest" ? "suggest" : "list");
    } catch (e) { fail("Couldn’t load that place")(e); }
  };
  const draw = (note) => {
    box.replaceChildren(...items.map((it, i) => {
      const b = document.createElement("button");
      b.className = `result${i === hl ? " hl" : ""}`;
      b.innerHTML = `<div class="txt"><div class="main"></div><div class="sec"></div></div>${it.saved ? `<span class="tag">Saved</span>` : ""}`;
      b.querySelector(".main").textContent = it.main;
      b.querySelector(".sec").textContent = it.secondary;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => choose(it);
      return b;
    }));
    if (note) box.insertAdjacentHTML("beforeend", `<div class="note">${esc(note)}</div>`);
    box.hidden = !items.length && !note;
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    // Saved places match instantly and cost nothing.
    const mine = q ? state.places.filter(p => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 4)
      .map(p => ({ saved: p, main: p.name, secondary: [p.type_label, shortArea(p.address)].filter(Boolean).join(" · ") })) : [];
    items = mine;
    hl = -1;
    draw();
    if (q.length < 3) return;
    const mySeq = ++seq;
    timer = setTimeout(async () => {
      try {
        const found = await g.suggestPlaces(q);
        if (mySeq !== seq) return;
        const savedIds = new Set(mine.map(m => m.saved.google_place_id));
        items = [...mine, ...found.filter(f => !savedIds.has(f.id))].slice(0, 8);
        draw(items.length ? "" : "No matches");
      } catch (e) {
        if (mySeq === seq) draw("Search isn’t working right now.");
        console.error(e);
      }
    }, 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); hl = Math.min(hl + 1, items.length - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hl = Math.max(hl - 1, 0); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[Math.max(hl, 0)]) choose(items[Math.max(hl, 0)]); }
    else if (e.key === "Escape") { input.value = ""; close(); }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("focus", () => { if (items.length) box.hidden = false; });
}

// ─── Where am I ──────────────────────────────────────────────────────
function locate() {
  if (!navigator.geolocation) return toast("Location isn’t available here", "err");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const pos = { lat: coords.latitude, lng: coords.longitude };
      g.removePin(mePin);
      mePin = g.addPin({ ...pos, colour: "#2f7df6", title: "You" });
      mePin.content.className = "me";
      g.focusOn(pos.lat, pos.lng, 13);
    },
    () => toast("Couldn’t get your location. Check Location Services for Safari.", "err"),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

// ─── Start ───────────────────────────────────────────────────────────
async function start() {
  $("login").hidden = true;
  ["top", "sheet", "locate"].forEach(id => $(id).hidden = false);
  try {
    let listTimer;
    await g.initMap($("map"), {
      takeRequest: db.takeGoogleRequest,
      // Keep "nearest the map centre" true as the map moves.
      onIdle: () => { clearTimeout(listTimer); listTimer = setTimeout(() => { if (state.view === "list") renderList($("sheet-body")); }, 200); },
    });
  } catch (e) {
    fail("The map didn’t load")(e);
  }
  try {
    [state.lists, state.places] = await Promise.all([db.loadLists(), db.loadPlaces()]);
  } catch (e) {
    fail("Couldn’t load your places")(e);
  }
  setupSearch();
  $("locate").onclick = locate;
  $("open-settings").onclick = () => { state.back = state.view === "suggest" ? "suggest" : "list"; state.view = "settings"; refresh(); growSheet("half"); };
  refresh();
  if (state.places.length) g.fitTo(state.places);
}

function showLogin() {
  $("login").hidden = false;
  const form = $("login-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await db.signIn(form.email.value.trim(), form.password.value);
      start();
    } catch (err) {
      $("login-error").textContent = err.message === "Invalid login credentials" ? "That email and password don’t match." : err.message;
    } finally { btn.disabled = false; }
  };
}

(await db.getSession()) ? start() : showLogin();
