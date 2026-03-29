// PEvO Discipline Taxonomy — based on OECD Fields of Research (Frascati Manual)
// See ARCHITECTURE.md §21

export interface DisciplineField {
  field: string;
  subfields: string[];
}

export const DISCIPLINE_TAXONOMY: DisciplineField[] = [
  {
    field: "Natural Sciences",
    subfields: [
      "Mathematics",
      "Computer Science",
      "Physics",
      "Chemistry",
      "Earth Sciences",
      "Biology",
      "Astronomy",
    ],
  },
  {
    field: "Engineering and Technology",
    subfields: [
      "Civil Engineering",
      "Electrical Engineering",
      "Mechanical Engineering",
      "Chemical Engineering",
      "Materials Engineering",
      "Biomedical Engineering",
      "Environmental Engineering",
    ],
  },
  {
    field: "Medical and Health Sciences",
    subfields: [
      "Basic Medicine",
      "Clinical Medicine",
      "Health Sciences",
      "Neuroscience",
      "Pharmacology",
    ],
  },
  {
    field: "Agricultural and Veterinary Sciences",
    subfields: [
      "Agriculture",
      "Animal Science",
      "Veterinary Science",
      "Forestry",
    ],
  },
  {
    field: "Social Sciences",
    subfields: [
      "Psychology",
      "Economics",
      "Education",
      "Sociology",
      "Law",
      "Political Science",
      "Geography",
    ],
  },
  {
    field: "Humanities and Arts",
    subfields: [
      "History",
      "Philosophy",
      "Languages and Literature",
      "Arts",
      "Theology",
    ],
  },
];

/** Flat list of all valid discipline sub-field values */
export const DISCIPLINES: string[] = DISCIPLINE_TAXONOMY.flatMap(
  (f) => f.subfields
);

/** Look up the top-level field for a given sub-field */
export function getFieldForDiscipline(
  discipline: string
): string | undefined {
  return DISCIPLINE_TAXONOMY.find((f) =>
    f.subfields.includes(discipline)
  )?.field;
}
