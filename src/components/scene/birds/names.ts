// The birds' names in te reo Māori, as the scene names their flocks: by
// eBird's English name for the species. Native and endemic birds only, as
// New Zealand Birds Online (nzbirdsonline.org.nz) gives them; introduced
// birds, and those without a name in common use, keep eBird's English one.
// A Māori noun doesn't change in the plural: a flock of kākā is "Kākā".

const MAORI = new Map(
  Object.entries({
    Tui: "Tūī",
    "New Zealand Kaka": "Kākā",
    "New Zealand Pigeon": "Kererū",
    "New Zealand Bellbird": "Korimako",
    "New Zealand Fantail": "Pīwakawaka",
    "Gray Gerygone": "Riroriro",
    Silvereye: "Tauhou",
    Whitehead: "Pōpokotea",
    "North Island Saddleback": "Tīeke",
    "North Island Robin": "Toutouwai",
    Tomtit: "Miromiro",
    Stitchbird: "Hihi",
    Rifleman: "Tītitipounamu",
    "Red-crowned Kakariki": "Kākāriki",
    "Shining Bronze-Cuckoo": "Pīpīwharauroa",
    "Long-tailed Koel": "Koekoeā",
    "Sacred Kingfisher": "Kōtare",
    Morepork: "Ruru",
    "New Zealand Falcon": "Kārearea",
    "Swamp Harrier": "Kāhu",
    "New Zealand Pipit": "Pīhoihoi",
    "Welcome Swallow": "Warou",
    "Kelp Gull": "Karoro",
    // eBird's Silver Gull, here, is the red-billed gull.
    "Silver Gull": "Tarāpunga",
    "Black-billed Gull": "Tarāpuka",
    "White-fronted Tern": "Tara",
    "Caspian Tern": "Taranui",
    "Pied Cormorant": "Kāruhiruhi",
    "Little Pied Cormorant": "Kawaupaka",
    "Great Cormorant": "Kawau",
    "Little Black Cormorant": "Kawau tūī",
    "Spotted Shag": "Parekareka",
    "Australasian Gannet": "Tākapu",
    "Fluttering Shearwater": "Pakahā",
    "Sooty Shearwater": "Tītī",
    "Flesh-footed Shearwater": "Toanui",
    "Westland Petrel": "Tāiko",
    "Fairy Prion": "Tītī wainui",
    "Northern Giant-Petrel": "Pāngurunguru",
    "Northern Royal Albatross": "Toroa",
    "Southern Royal Albatross": "Toroa",
    "White-capped Albatross": "Toroa",
    "Salvin's Albatross": "Toroa",
    "Brown Skua": "Hākoakoa",
    "Paradise Shelduck": "Pūtangitangi",
    "New Zealand Scaup": "Pāpango",
    "Black Swan": "Kakīānau",
    "Brown Teal": "Pāteke",
    "Pacific Black Duck": "Pārera",
    "Australasian Shoveler": "Kuruwhengi",
    "Variable Oystercatcher": "Tōrea pango",
    "South Island Oystercatcher": "Tōrea",
    "Double-banded Plover": "Pohowera",
    "Pied Stilt": "Poaka",
    "Bar-tailed Godwit": "Kuaka",
    "White-faced Heron": "Matuku moana",
    "Pacific Reef-Heron": "Matuku moana",
    "Royal Spoonbill": "Kōtuku ngutupapa",
    "Australasian Swamphen": "Pūkeko",
    "South Island Takahe": "Takahē",
    "Little Penguin": "Kororā",
    "Little Spotted Kiwi": "Kiwi pukupuku",
  })
);

/** "Fluttering Shearwaters", "Common Chaffinches": a flock of them. */
export function plural(name: string) {
  if (/(s|x|ch|sh)$/i.test(name)) return `${name}es`;

  return name.endsWith("y") && !/[aeiou]y$/i.test(name)
    ? `${name.slice(0, -1)}ies`
    : `${name}s`;
}

/** A flock's name, from eBird's for its species: Māori if it has one. */
export function flockName(english: string) {
  return MAORI.get(english) ?? plural(english);
}
