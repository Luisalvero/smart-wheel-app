/**
 * What heart rate and SpO2 to expect for a given driver, before we have seen
 * any of their drives -- the "profile prior" -- and the validated clinical
 * bands every reading is also checked against.
 *
 * Three layers, from most general to most personal:
 *
 * 1. Clinical deterioration bands (NEWS2, Royal College of Physicians 2017).
 *    Pulse: ≤40 → 3, 41–50 → 1, 51–90 → 0, 91–110 → 1, 111–130 → 2, ≥131 → 3.
 *    SpO2 Scale 1: ≤91 → 3, 92–93 → 2, 94–95 → 1, ≥96 → 0.
 *    SpO2 Scale 2 (confirmed hypercapnic respiratory failure, e.g. some COPD):
 *    ≤83 → 3, 84–85 → 2, 86–87 → 1, 88–92 → 0 (on air).
 *    These are what make a reading a WARNING or CRITICAL; they do not move
 *    with the profile, because a clinically dangerous value is dangerous
 *    whoever you are -- with one exception, COPD oxygen (below).
 *
 *    COPD: people with stable COPD live at a lower normal saturation. In
 *    Little et al. 1999 (Respir Med 93:202-207; 33 stable, normoxic or mildly
 *    hypoxic patients) awake SaO2 was 93.9 ± 1.6 %, i.e. inside NEWS2
 *    Scale 1's warning band, so Scale 1 would flag them all day. The paper
 *    defines a clinically significant desaturation as a fall of MORE THAN 4
 *    points from the person's own awake baseline. For COPD drivers oxygen is
 *    therefore judged relative to their baseline (their learned median once
 *    established, else 93.9 %): notice at a 3-point fall, warning at a fall
 *    of more than 4, critical at ≤ 85 % (NEWS2 Scale 2 score 2). Scale 2
 *    itself needs blood-gas-confirmed hypercapnia, which a profile cannot
 *    know, so it is not applied wholesale.
 *
 * 2. Real-world population norms for this profile (Avram et al. 2019, npj
 *    Digital Medicine 2:58, 66,788 participants, smartphone PPG -- the
 *    "reference profiles" workbook). Expected mean HR starts from the
 *    age-stratum geometric mean ± SD (Table 2, healthy participants) and is
 *    adjusted with the paper's multivariable coefficients (Table 4):
 *      sex: female +4.28 bpm vs male (Model 2) -- applied as ±2.14 around the
 *           ~50/50 stratum mean; unspecified sex gets no adjustment
 *      BMI: +0.21 bpm per kg/m² (Model 1), relative to the cohort mean 27.5
 *      conditions / medications with p < 0.05 in Model 2 (below). Effects
 *           that were not significant (beta blockers, amiodarone, CAD, MI,
 *           PVD, stroke, CHF) are recorded but not applied.
 *    This layer says what is *unusual for someone like this driver*; it
 *    drives the NOTICE level and, combined with a clinical band, WARNING.
 *
 * 3. The driver's own baseline, learned from their finished drives
 *    (lib/analysis/baseline.ts). It gradually replaces layer 2 as data
 *    accumulates (see personalBand()).
 *
 * Not a medical device. The population numbers describe real-world
 * smartphone-PPG measurements, not diagnostic limits.
 */

export type Sex = 'male' | 'female' | 'other' | 'prefer_not_to_say' | null;

export const CONDITIONS = [
  { key: 'hypertension', label: 'High blood pressure', hr: 1.83 },
  { key: 'diabetes', label: 'Diabetes', hr: 4.48 },
  { key: 'hypercholesterolemia', label: 'High cholesterol', hr: 1.35 },
  { key: 'arrhythmia', label: 'Arrhythmia / AFib', hr: 1.65 },
  { key: 'sleep_apnea', label: 'Sleep apnea', hr: 3.67 },
  { key: 'asthma', label: 'Asthma', hr: 1.51 },
  { key: 'copd', label: 'COPD', hr: 2.49 },
  { key: 'cad', label: 'Coronary artery disease', hr: 0 }, // −0.28, p = 0.51
  { key: 'prior_mi', label: 'Prior heart attack', hr: 0 }, // −0.25, p = 0.68
  { key: 'chf', label: 'Heart failure', hr: 0 }, // +0.36, p = 0.62
  { key: 'pvd', label: 'Peripheral vascular disease', hr: 0 }, // +0.28, p = 0.72
  { key: 'prior_stroke', label: 'Prior stroke', hr: 0 }, // +0.64, p = 0.24
] as const;

export const MEDICATIONS = [
  { key: 'beta_blocker', label: 'Beta blocker', hr: 0 }, // −0.48, p = 0.14 (can blunt HR rises; noted in UI)
  { key: 'ccb_non_dhp', label: 'Calcium-channel blocker (diltiazem/verapamil)', hr: 4.11 },
  { key: 'amiodarone', label: 'Amiodarone', hr: 0 }, // −2.07, p = 0.30
  { key: 'beta_agonist', label: 'Inhaled beta-agonist (inhaler)', hr: 0 }, // +2.58, p = 0.06
] as const;

export type ConditionKey = (typeof CONDITIONS)[number]['key'];
export type MedicationKey = (typeof MEDICATIONS)[number]['key'];

/** Avram 2019 Table 2: geometric mean HR ± SD by age, healthy participants. */
const AGE_STRATA: { maxAge: number; mean: number; sd: number }[] = [
  { maxAge: 20, mean: 81.6, sd: 14.0 },
  { maxAge: 30, mean: 80.2, sd: 14.8 },
  { maxAge: 40, mean: 78.5, sd: 15.1 },
  { maxAge: 50, mean: 75.3, sd: 14.3 },
  { maxAge: 60, mean: 73.9, sd: 13.5 },
  { maxAge: 70, mean: 73.0, sd: 12.7 },
  { maxAge: 80, mean: 74.2, sd: 11.1 },
  { maxAge: Infinity, mean: 78.1, sd: 16.5 },
];
/** Whole cohort, for drivers without an age: 79.1 ± 14.5. */
const ALL_AGES = { mean: 79.1, sd: 14.5 };
const COHORT_MEAN_BMI = 27.5;

export type DriverProfileInput = {
  age: number | null;
  sex: Sex;
  weight_kg: number | null;
  height_cm: number | null;
  conditions: string[];
  medications: string[];
};

export function bmi(weightKg: number | null, heightCm: number | null): number | null {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function bmiCategory(b: number | null): string | null {
  if (b === null) return null;
  return b < 18.5 ? 'underweight' : b < 25 ? 'healthy weight' : b < 30 ? 'overweight' : 'obesity';
}

export type ProfilePrior = {
  /** Expected mean HR for this profile (bpm). */
  hrMean: number;
  /** Between-person spread for this profile (bpm, 1 SD). */
  hrSd: number;
  /** Tanaka 2001: 208 − 0.7 × age (bpm); null without an age. */
  hrMax: number | null;
  /** COPD drivers: oxygen is judged relative to this awake baseline (Little
   *  et al. 1999 population mean until the driver's own median is known). */
  spo2Baseline: number | null;
  bmi: number | null;
  /** Human-readable account of every adjustment, for the UI and the docs. */
  explain: string[];
};

/** Little et al. 1999, Table 1: awake SaO2 in stable COPD, 93.9 ± 1.6 %. */
export const COPD_AWAKE_SPO2 = 93.9;

export function profilePrior(p: DriverProfileInput): ProfilePrior {
  const explain: string[] = [];
  const stratum = p.age ? AGE_STRATA.find((s) => p.age! <= s.maxAge)! : null;
  let hrMean = stratum ? stratum.mean : ALL_AGES.mean;
  const hrSd = stratum ? stratum.sd : ALL_AGES.sd;
  explain.push(
    stratum
      ? `age ${p.age}: population mean ${stratum.mean} ± ${stratum.sd} bpm (Avram 2019, Table 2)`
      : `no age: all-ages mean ${ALL_AGES.mean} ± ${ALL_AGES.sd} bpm`,
  );
  if (p.sex === 'female') {
    hrMean += 2.14;
    explain.push('female: +2.1 bpm (half of the +4.28 female–male difference)');
  } else if (p.sex === 'male') {
    hrMean -= 2.14;
    explain.push('male: −2.1 bpm');
  }
  const b = bmi(p.weight_kg, p.height_cm);
  if (b !== null) {
    const d = 0.21 * (b - COHORT_MEAN_BMI);
    hrMean += d;
    explain.push(`BMI ${b}: ${d >= 0 ? '+' : ''}${d.toFixed(1)} bpm (0.21 per kg/m² vs 27.5)`);
  }
  for (const c of CONDITIONS) {
    if (p.conditions.includes(c.key) && c.hr) {
      hrMean += c.hr;
      explain.push(`${c.label}: +${c.hr} bpm`);
    }
  }
  for (const m of MEDICATIONS) {
    if (p.medications.includes(m.key) && m.hr) {
      hrMean += m.hr;
      explain.push(`${m.label}: +${m.hr} bpm`);
    }
  }
  const copd = p.conditions.includes('copd');
  if (copd) explain.push(`COPD: oxygen judged against your own baseline (start ${COPD_AWAKE_SPO2}%, Little 1999)`);
  return {
    hrMean: Math.round(hrMean * 10) / 10,
    hrSd,
    hrMax: p.age ? Math.round(208 - 0.7 * p.age) : null,
    spo2Baseline: copd ? COPD_AWAKE_SPO2 : null,
    bmi: b,
    explain,
  };
}

// ------------------------------------------------------------- NEWS2 scoring
export function news2Pulse(hr: number): 0 | 1 | 2 | 3 {
  if (hr <= 40) return 3;
  if (hr <= 50) return 1;
  if (hr <= 90) return 0;
  if (hr <= 110) return 1;
  if (hr <= 130) return 2;
  return 3;
}

export function news2Spo2(spo2: number, scale: 1 | 2): 0 | 1 | 2 | 3 {
  if (scale === 1) {
    if (spo2 <= 91) return 3;
    if (spo2 <= 93) return 2;
    if (spo2 <= 95) return 1;
    return 0;
  }
  if (spo2 <= 83) return 3;
  if (spo2 <= 85) return 2;
  if (spo2 <= 87) return 1;
  return 0; // 88–92 is the target on Scale 2; readings above it on air also score 0
}

/**
 * The band a driver is judged against: the profile prior blended with their
 * own learned baseline. Weight on the personal baseline grows with evidence,
 * w = n / (n + 600): 10 minutes of good signal counts as much as the whole
 * population prior. SD never drops below 6 bpm, so a very steady driver isn't
 * flagged for ordinary variation.
 */
export function personalBand(
  prior: ProfilePrior,
  baseline: { readings: number; bpmMedian: number | null; bpmP10: number | null; bpmP90: number | null } | null,
): { mean: number; sd: number; weight: number } {
  if (!baseline || baseline.bpmMedian === null || baseline.bpmP10 === null || baseline.bpmP90 === null || baseline.readings < 30) {
    return { mean: prior.hrMean, sd: prior.hrSd, weight: 0 };
  }
  const w = baseline.readings / (baseline.readings + 600);
  // p10..p90 of a normal distribution spans 2 × 1.2816 SD.
  const personalSd = Math.max(6, (baseline.bpmP90 - baseline.bpmP10) / 2.5631);
  return {
    mean: w * baseline.bpmMedian + (1 - w) * prior.hrMean,
    sd: Math.max(6, w * personalSd + (1 - w) * prior.hrSd),
    weight: w,
  };
}
