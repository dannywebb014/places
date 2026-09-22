// ─── Google Maps and Places ──────────────────────────────────────────
//
// Everything that talks to Google lives here. Two kinds of request cost
// money beyond Google's free allowance (1,000 a month each): fetching a
// place's details and a nearby search. Both go through `paid()`, which asks
// the database for permission first; the database refuses at 25 a day or
// 700 a month. Map loads and search-as-you-type have much larger free
// allowances (10,000 a month) and are not counted.

import { GOOGLE_MAPS_KEY, GOOGLE_MAP_ID } from "./config.js";

// Google's official loader, which defines google.maps.importLibrary.
/* eslint-disable */
(g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({key:GOOGLE_MAPS_KEY,v:"weekly",region:"GB",language:"en-GB"});
/* eslint-enable */

// The details kept for a saved place. "allows dogs" and "good for children"
// put these requests in Google's top price tier, which is why they are
// rationed; they are the point of the Oscar and Taco suggestions.
const FIELDS = [
  "id", "displayName", "formattedAddress", "location", "googleMapsURI", "websiteURI",
  "rating", "userRatingCount", "priceLevel", "primaryTypeDisplayName",
  "allowsDogs", "isGoodForChildren", "hasMenuForChildren",
];

let lib = {};
let map;
let paid = async () => true;

export async function initMap(el, { onIdle, takeRequest }) {
  paid = takeRequest;
  const [{ Map }, { AdvancedMarkerElement }, places] = await Promise.all([
    google.maps.importLibrary("maps"),
    google.maps.importLibrary("marker"),
    google.maps.importLibrary("places"),
  ]);
  lib = { AdvancedMarkerElement, ...places };
  map = new Map(el, {
    center: { lat: 54.3, lng: -2.8 },
    zoom: 6,
    mapId: GOOGLE_MAP_ID,
    colorScheme: "FOLLOW_SYSTEM",
    disableDefaultUI: true,
    zoomControl: false,
    clickableIcons: false,
    gestureHandling: "greedy",
  });
  // Show the whole of the UK whatever the screen shape, until there are
  // saved places to fit to instead.
  map.fitBounds({ south: 49.9, west: -8.2, north: 58.7, east: 1.8 }, 0);
  if (onIdle) map.addListener("idle", onIdle);
  return map;
}

export const getMap = () => map;

// ── Pins ──
export function addPin({ lat, lng, colour, done = false, suggestion = false, title, onClick }) {
  const el = document.createElement("div");
  el.className = `pin${done ? " done" : ""}${suggestion ? " suggestion" : ""}`;
  el.style.setProperty("--c", colour);
  if (done) el.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const marker = new lib.AdvancedMarkerElement({ map, position: { lat, lng }, content: el, title, zIndex: suggestion ? 1 : done ? 2 : 3 });
  if (onClick) marker.addListener("click", onClick);
  return marker;
}
export const removePin = (marker) => { if (marker) marker.map = null; };

// `below` is how much of the map, in pixels, is covered at the bottom (the
// sheet on a phone), so the place lands in the part still visible.
export function focusOn(lat, lng, zoom = 14, below = 0) {
  if (map.getZoom() < zoom) map.setZoom(zoom);
  map.setCenter({ lat, lng });
  if (below) map.panBy(0, below / 2);
}

export function fitTo(points) {
  if (!points.length) return;
  if (points.length === 1) return focusOn(points[0].lat, points[0].lng, 13);
  const bounds = new google.maps.LatLngBounds();
  points.forEach(p => bounds.extend(p));
  map.fitBounds(bounds, 60);
}

// ── Search as you type ──
// One session token per search, ended by fetching the chosen place, which is
// how Google bills the typing as a single session rather than per letter.
let session;
export async function suggestPlaces(input) {
  session ||= new lib.AutocompleteSessionToken();
  const { suggestions } = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input,
    sessionToken: session,
    locationBias: map.getBounds(),
    region: "gb",
    language: "en-GB",
  });
  return suggestions
    .map(s => s.placePrediction)
    .filter(Boolean)
    .map(p => ({ id: p.placeId, main: p.mainText?.toString() || p.text.toString(), secondary: p.secondaryText?.toString() || "", prediction: p }));
}

export async function placeFromSuggestion(s) {
  if (!(await paid())) throw new LimitError();
  const place = s.prediction.toPlace();
  await place.fetchFields({ fields: FIELDS });
  session = null;
  return fromGoogle(place);
}

// ── Suggestions near a point ──
export async function searchNearby({ center, radius, types }) {
  if (!(await paid())) throw new LimitError();
  const { places } = await lib.Place.searchNearby({
    fields: FIELDS,
    locationRestriction: { center, radius: Math.min(Math.max(radius, 1000), 50000) },
    includedTypes: types,
    maxResultCount: 20,
    rankPreference: lib.SearchNearbyRankPreference.POPULARITY,
    region: "gb",
    language: "en-GB",
  });
  return places.map(fromGoogle);
}

export class LimitError extends Error {
  constructor() { super("Today’s Google limit is reached, to keep it free. It resets tomorrow."); }
}

// Google's place object, reduced to what a saved place stores.
function fromGoogle(p) {
  const loc = p.location?.toJSON?.() || {};
  return {
    google_place_id: p.id,
    name: p.displayName || "Unnamed place",
    address: p.formattedAddress || "",
    lat: loc.lat,
    lng: loc.lng,
    type_label: p.primaryTypeDisplayName || "",
    google_maps_uri: p.googleMapsURI || "",
    website: p.websiteURI || "",
    rating: p.rating ?? null,
    rating_count: p.userRatingCount ?? null,
    price_level: p.priceLevel || null,
    allows_dogs: p.allowsDogs ?? null,
    good_for_children: p.isGoodForChildren ?? (p.hasMenuForChildren ? true : null),
  };
}

// Links out for directions. Apple Maps opens the app on an iPhone or iPad.
export const appleMapsUrl = (p) =>
  `https://maps.apple.com/?q=${encodeURIComponent(p.name)}&ll=${p.lat},${p.lng}`;
export const googleMapsUrl = (p) =>
  p.google_maps_uri || `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
