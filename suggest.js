// ─── What "Suggestions" asks Google for ──────────────────────────────
//
// Google can't filter a nearby search by "good for children" or "allows
// dogs", so each choice asks for place types that suit it, and the results
// are then sorted: places Google confirms first, the rest after, labelled as
// not confirmed. Nothing is hidden, because Google's flags are often missing
// rather than false.

export const SUGGEST_WHAT = [
  { id: "food", label: "Eat & drink" },
  { id: "things", label: "Things to do" },
];

export const SUGGEST_WHO = [
  { id: "anyone", label: "Anyone" },
  { id: "oscar", label: "With Oscar" },
  { id: "taco", label: "With Taco" },
];

// Place types from Google's Places API (New) "Table A".
const TYPES = {
  food: {
    anyone: ["restaurant", "cafe"],
    oscar: ["restaurant", "cafe"],
    taco: ["pub", "cafe", "restaurant"],
  },
  things: {
    anyone: ["tourist_attraction", "museum", "historical_landmark", "park", "art_gallery", "zoo", "aquarium", "amusement_park"],
    oscar: ["playground", "zoo", "aquarium", "amusement_park", "amusement_center", "museum", "park", "bowling_alley"],
    taco: ["dog_park", "park", "hiking_area", "national_park"],
  },
};

export const suggestionTypes = (what, who) => TYPES[what][who];

// Family days out and dog walks are suitable by their type, so only an
// explicit "no" from Google counts against them. Restaurants and pubs need
// Google to say yes.
export function matchesWho(place, who) {
  if (who === "oscar") return place.good_for_children === true || (place.good_for_children !== false && isFamilyType(place));
  if (who === "taco") return place.allows_dogs === true || (place.allows_dogs !== false && isDogType(place));
  return true;
}

const has = (place, words) => words.some(w => (place.type_label || "").toLowerCase().includes(w));
const isFamilyType = (p) => has(p, ["playground", "zoo", "aquarium", "amusement", "museum", "park", "bowling"]);
const isDogType = (p) => has(p, ["dog park", "park", "hiking", "national park", "trail", "woodland", "beach"]);

export const whoLabel = (who) => ({ oscar: "Family friendly", taco: "Dog friendly" })[who] || "";
