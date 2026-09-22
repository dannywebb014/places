// ─── Supabase: sign-in, lists, places and the Google usage counter ───
//
// Same project and account as foodhub. Every call throws on error rather
// than returning quietly, so a failed save is always shown to the user.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const check = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// ── Session ──
export const getSession = async () => (await supabase.auth.getSession()).data.session;
export const onAuthChange = (fn) => supabase.auth.onAuthStateChange((_e, session) => fn(session));
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password }).then(check);
export const signOut = () => supabase.auth.signOut();

// ── Lists ──
export const DEFAULT_LISTS = [
  { name: "Restaurants",   colour: "#d0633a" },
  { name: "Things to do",  colour: "#3d7fc4" },
  { name: "Oscar",         colour: "#2f8a84" },
  { name: "Taco",          colour: "#9a6a3a" },
  { name: "Date nights",   colour: "#c2417a" },
  { name: "Want to visit", colour: "#7d6fd6" },
];

export async function loadLists() {
  const lists = check(await supabase.from("places_lists").select("*").order("position"));
  if (lists.length) return lists;
  // First visit: create the starting lists.
  return check(await supabase.from("places_lists")
    .insert(DEFAULT_LISTS.map((l, i) => ({ ...l, position: i })))
    .select("*").order("position"));
}
export const addList = async (name, colour, position) =>
  check(await supabase.from("places_lists").insert({ name, colour, position }).select().single());
export const updateList = async (id, changes) =>
  check(await supabase.from("places_lists").update(changes).eq("id", id).select().single());
export const deleteList = async (id) =>
  check(await supabase.from("places_lists").delete().eq("id", id));

// ── Places ──
export const loadPlaces = async () =>
  check(await supabase.from("places_places").select("*").order("created_at", { ascending: false }));
export const addPlace = async (place) =>
  check(await supabase.from("places_places").insert(place).select().single());
export const updatePlace = async (id, changes) =>
  check(await supabase.from("places_places")
    .update({ ...changes, updated_at: new Date().toISOString() }).eq("id", id).select().single());
export const deletePlace = async (id) =>
  check(await supabase.from("places_places").delete().eq("id", id));

// ── Google usage ──
// Asks the database for one paid Google request. False means a limit has been
// reached; the database decides so the page cannot be talked out of it.
export async function takeGoogleRequest() {
  return check(await supabase.rpc("places_take_google_request")) === true;
}
export async function googleUsage() {
  const rows = check(await supabase.rpc("places_google_usage"));
  return rows?.[0] || { today: 0, month: 0 };
}
