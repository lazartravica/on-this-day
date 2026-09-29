export interface HistoricalEvent {
  year: number;
  text: string;
}

/** A deliberately tiny archive, keyed by "MM-DD". */
const EVENTS: Record<string, HistoricalEvent[]> = {
  "01-01": [
    { year: 1801, text: "The Act of Union takes effect, creating the United Kingdom of Great Britain and Ireland." },
    { year: 1863, text: "The Emancipation Proclamation takes effect in the United States." },
    { year: 1999, text: "The euro is introduced as an accounting currency in eleven EU countries." },
  ],
  "02-14": [
    { year: 1876, text: "Alexander Graham Bell and Elisha Gray both file telephone patent paperwork." },
    { year: 1929, text: "The Saint Valentine's Day Massacre takes place in Chicago." },
  ],
  "03-14": [
    { year: 1879, text: "Albert Einstein is born in Ulm, Germany." },
    { year: 2018, text: "Physicist Stephen Hawking dies in Cambridge, England." },
  ],
  "04-12": [
    { year: 1961, text: "Yuri Gagarin becomes the first human to travel into outer space." },
    { year: 1981, text: "Space Shuttle Columbia launches on STS-1, the first shuttle mission." },
  ],
  "05-29": [
    { year: 1453, text: "Constantinople falls to the Ottoman army under Mehmed II." },
    { year: 1953, text: "Edmund Hillary and Tenzing Norgay reach the summit of Mount Everest." },
  ],
  "06-06": [
    { year: 1844, text: "The YMCA is founded in London." },
    { year: 1944, text: "D-Day: Allied forces land on the beaches of Normandy." },
  ],
  "07-20": [{ year: 1969, text: "Apollo 11's lunar module lands on the Moon; Neil Armstrong walks on the surface hours later." }],
  "08-06": [
    { year: 1945, text: "The United States drops an atomic bomb on Hiroshima." },
    { year: 1991, text: "Tim Berners-Lee posts a public summary of the World Wide Web project." },
  ],
  "09-21": [
    { year: 1792, text: "The French National Convention abolishes the monarchy." },
    { year: 1937, text: "J. R. R. Tolkien's The Hobbit is published." },
    { year: 1964, text: "Malta gains independence from the United Kingdom." },
    { year: 1981, text: "Belize gains independence from the United Kingdom." },
  ],
  "10-04": [{ year: 1957, text: "The Soviet Union launches Sputnik 1, the first artificial satellite." }],
  "10-12": [{ year: 1492, text: "Christopher Columbus's expedition makes landfall in the Bahamas." }],
  "11-09": [{ year: 1989, text: "The Berlin Wall falls as East Germany opens its border crossings." }],
  "12-17": [{ year: 1903, text: "The Wright brothers make the first powered, controlled airplane flight." }],
};

const DATE_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Normalizes "MM-DD" (or undefined → today in UTC). Returns null when invalid. */
export function normalizeDate(input: string | undefined): string | null {
  if (!input) {
    const now = new Date();
    return `${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }
  return DATE_RE.test(input) ? input : null;
}

export function eventsOn(date: string): HistoricalEvent[] | undefined {
  return EVENTS[date];
}

export function availableDates(): string[] {
  return Object.keys(EVENTS).sort();
}
