// v5 §2.1 / §2.3 — the shared contact validators (src/lib/validation/contact.ts), table-driven: CV-1/CV-2 mobilePhone,
// CV-3 contactPhone, CV-4 email, CV-5 loginIdentifier, CV-7 the test-only allowlist, and the CV-10 audit rule.
// The production rules are tested with the allowlist switched off (it is on under Vitest by design).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CONTACT_PHONE_MESSAGE,
  EMAIL_MESSAGE,
  LOGIN_IDENTIFIER_MESSAGE,
  MOBILE_MESSAGE,
  TEST_ONLY_PHONES,
  classifyLoginIdentifier,
  clearableContact,
  contactPhone,
  email,
  formatPhone,
  isObviousFakeNumber,
  isTestAllowlistActive,
  loginIdentifier,
  mobilePhone,
  normaliseContactPhone,
  normaliseEmail,
  normaliseMobile,
  optionalContact,
} from "@/lib/validation/contact";
import { classifyContactInput, scanContactInputs } from "../audit/contact-inputs";

function productionRules() {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CONTACTS_TEST_ALLOWLIST", "");
}

const MOBILE_VALID: Array<[string, string]> = [
  ["9811000001", "9811000001"],
  ["+91 98110 00001", "9811000001"],
  ["+919811000001", "9811000001"],
  ["+91-98110-00001", "9811000001"],
  ["91 98110 00001", "9811000001"],
  ["919811000001", "9811000001"],
  ["09811000001", "9811000001"],
  ["0 98110 00001", "9811000001"],
  ["(+91) 98110 00001", "9811000001"],
  ["(0) 98110-00001", "9811000001"],
  ["98110-00001", "9811000001"],
  ["981.100.0001", "9811000001"],
  ["  9811000001  ", "9811000001"],
  ["+91 (981) 100-0001", "9811000001"],
  ["6000000001", "6000000001"],
  ["7012345679", "7012345679"],
  ["8899001122", "8899001122"],
  ["9876512345", "9876512345"],
  ["9000000000", "9000000000"],
];

const MOBILE_INVALID: string[] = [
  "",
  "   ",
  "12345",
  "981100000", // 9 digits
  "98110000011", // 11 digits without a leading 0
  "5811000001", // starts with 5
  "0811000001", // 10 digits starting with 0
  "1234567890",
  "9999999999", // all the same digit
  "8888888888",
  "6666666666",
  "9876543210", // descending sequence (test-only allowlist)
  "6789012345", // ascending sequence
  "8765432109",
  "+9811000001", // "+" without 91
  "+92 98110 00001", // another country
  "+1 415 555 0100",
  "00919811000001",
  "+91 0 98110 00001",
  "98110 0000a",
  "phone: 9811000001",
  "9811000001 ext 2",
  "91 58110 00001",
  "9811000001/2",
];

const CONTACT_VALID: Array<[string, string]> = [
  ["9811000001", "9811000001"],
  ["+91 98110 00001", "9811000001"],
  ["022 2345 6789", "2223456789"],
  ["+91 22 2345 6789", "2223456789"],
  ["0265 222 3333", "2652223333"],
  ["(0265) 2223333", "2652223333"],
  ["02652223333", "2652223333"],
  ["2652223333", "2652223333"],
  ["033-2456-7890", "3324567890"],
  ["040 2345 6789", "4023456789"],
  ["+91-44-23456789", "4423456789"],
  ["0532 2345678", "5322345678"],
  ["080 4123 4567", "8041234567"],
  ["0712 2345678", "7122345678"],
  ["912223456789", "2223456789"],
  ["(022) 2345-6789", "2223456789"],
];

const CONTACT_INVALID: string[] = [
  "",
  "011 2345 6789", // STD codes starting with 1 are not accepted (spec: first digit 2–5)
  "1123456789",
  "+91 11 2345 6789",
  "2222222222",
  "2345678901", // ascending sequence
  "5432109876", // descending sequence
  "0000000000",
  "0222345678",
  "22 2345 678",
  "022 2345 67890",
  "6345",
  "abc",
  "+44 20 7946 0958",
  "9999999999",
  "022-2345-678x",
];

const EMAIL_VALID: Array<[string, string]> = [
  ["a@b.co", "a@b.co"],
  ["rahul@example.com", "rahul@example.com"],
  ["Rahul.Mehta@Example.COM", "rahul.mehta@example.com"],
  ["  neha@gmail.com  ", "neha@gmail.com"],
  ["first.last@sub.domain.in", "first.last@sub.domain.in"],
  ["user+tag@club.co.in", "user+tag@club.co.in"],
  ["o'brien@mail.ie", "o'brien@mail.ie"],
  ["x_y-z@my-club.org", "x_y-z@my-club.org"],
  ["123@numbers.net", "123@numbers.net"],
  ["a.b.c.d@e.fg", "a.b.c.d@e.fg"],
  ["UPPER@CASE.IO", "upper@case.io"],
  ["mixed.Case+X@Domain.Travel", "mixed.case+x@domain.travel"],
  ["name@xn--80ak6aa92e.com", "name@xn--80ak6aa92e.com"],
  ["a@b-c.d-e.com", "a@b-c.d-e.com"],
  ["ab@c.museum", "ab@c.museum"],
  ["desk@championsclub.example", "desk@championsclub.example"],
];

const EMAIL_INVALID: string[] = [
  "",
  "plain",
  "@example.com",
  "user@",
  "user@domain",
  "user@domain.c",
  "user@domain.123",
  "us er@example.com",
  "user@@example.com",
  "a@b@c.com",
  ".user@example.com",
  "user.@example.com",
  "us..er@example.com",
  "user@example..com",
  "user@.example.com",
  "user@example.com.",
  "user@-example.com",
  "user@exa_mple.com",
  `${"a".repeat(65)}@example.com`,
  `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`, // 260 characters
];

const LOGIN_VALID: Array<[string, { kind: "mobile" | "email"; value: string }]> = [
  ["9811000001", { kind: "mobile", value: "9811000001" }],
  ["+91 98110 00001", { kind: "mobile", value: "9811000001" }],
  ["09811000001", { kind: "mobile", value: "9811000001" }],
  ["919811000001", { kind: "mobile", value: "9811000001" }],
  ["98110-00001", { kind: "mobile", value: "9811000001" }],
  ["(+91) 7012345679", { kind: "mobile", value: "7012345679" }],
  ["6000000001", { kind: "mobile", value: "6000000001" }],
  ["8899 001 122", { kind: "mobile", value: "8899001122" }],
  ["owner@championsclub.example", { kind: "email", value: "owner@championsclub.example" }],
  ["Manager@ChampionsClub.Example", { kind: "email", value: "manager@championsclub.example" }],
  ["  desk@test.club ", { kind: "email", value: "desk@test.club" }],
  ["rahul@example.com", { kind: "email", value: "rahul@example.com" }],
  ["first.last+x@club.co.in", { kind: "email", value: "first.last+x@club.co.in" }],
  ["a@b.co", { kind: "email", value: "a@b.co" }],
  ["UPPER@CASE.IO", { kind: "email", value: "upper@case.io" }],
  ["+919000000001", { kind: "mobile", value: "9000000001" }],
];

const LOGIN_INVALID: string[] = [
  "",
  "abc",
  "12345",
  "rahul",
  "rahul@",
  "@example.com",
  "user@domain",
  "9999999999",
  "9876543210",
  "5811000001",
  "+1 415 555 0100",
  "us er@example.com",
  "98110 0000a",
  "user@@example.com",
  "022 2345 6789", // a landline is not a login
  "CC-000123", // member codes are accepted only by the login route (v3 WK-2), not by this validator
];

describe("v5 CV-1/CV-2 mobilePhone", () => {
  beforeEach(productionRules);
  afterEach(() => vi.unstubAllEnvs());

  it(`accepts ${MOBILE_VALID.length} formats and stores the canonical 10 digits`, () => {
    expect(MOBILE_VALID.length).toBeGreaterThanOrEqual(15);
    for (const [input, out] of MOBILE_VALID) {
      expect(normaliseMobile(input), input).toBe(out);
      expect(mobilePhone.parse(input), input).toBe(out);
    }
  });

  it(`rejects ${MOBILE_INVALID.length} invalid values with the exact message`, () => {
    expect(MOBILE_INVALID.length).toBeGreaterThanOrEqual(15);
    for (const input of MOBILE_INVALID) {
      expect(normaliseMobile(input), input).toBeNull();
      const r = mobilePhone.safeParse(input);
      expect(r.success, input).toBe(false);
      expect(r.error?.issues[0].message).toBe(MOBILE_MESSAGE);
    }
    expect(MOBILE_MESSAGE).toBe("Enter a valid 10-digit Indian mobile number.");
  });

  it("CV-2: all-same digits and running sequences are obvious fakes; ordinary numbers are not", () => {
    for (const d of ["9999999999", "9876543210", "6789012345", "9012345678", "2345678901", "5432109876"]) expect(isObviousFakeNumber(d), d).toBe(true);
    for (const d of ["9811000001", "9876512345", "9000000000", "9898989898"]) expect(isObviousFakeNumber(d), d).toBe(false);
  });

  it("non-strings are invalid", () => {
    expect(normaliseMobile(null)).toBeNull();
    expect(normaliseMobile(undefined)).toBeNull();
    expect(mobilePhone.safeParse(9811000001).success).toBe(false);
  });
});

describe("v5 CV-3 contactPhone", () => {
  beforeEach(productionRules);
  afterEach(() => vi.unstubAllEnvs());

  it(`accepts ${CONTACT_VALID.length} mobiles and STD landlines, stored normalised`, () => {
    expect(CONTACT_VALID.length).toBeGreaterThanOrEqual(15);
    for (const [input, out] of CONTACT_VALID) {
      expect(normaliseContactPhone(input), input).toBe(out);
      expect(contactPhone.parse(input), input).toBe(out);
    }
  });

  it(`rejects ${CONTACT_INVALID.length} invalid values with the exact message`, () => {
    expect(CONTACT_INVALID.length).toBeGreaterThanOrEqual(15);
    for (const input of CONTACT_INVALID) {
      expect(normaliseContactPhone(input), input).toBeNull();
      expect(contactPhone.safeParse(input).error?.issues[0].message, input).toBe(CONTACT_PHONE_MESSAGE);
    }
    expect(CONTACT_PHONE_MESSAGE).toBe("Enter a valid Indian phone number with STD code.");
  });

  it("is displayed formatted", () => {
    expect(formatPhone("9811000001")).toBe("+91 98110 00001");
    expect(formatPhone("+91 98110-00001")).toBe("+91 98110 00001");
    expect(formatPhone("2223456789")).toBe("+91 22 2345 6789");
    expect(formatPhone("2652223333")).toBe("+91 265 2223333");
    expect(formatPhone("0265 222 3333")).toBe("+91 265 2223333");
    expect(formatPhone("not a number")).toBe("not a number");
    expect(formatPhone(null)).toBe("");
  });
});

describe("v5 CV-4 email", () => {
  it(`accepts ${EMAIL_VALID.length} addresses, trimmed and lower-cased`, () => {
    expect(EMAIL_VALID.length).toBeGreaterThanOrEqual(15);
    for (const [input, out] of EMAIL_VALID) {
      expect(normaliseEmail(input), input).toBe(out);
      expect(email.parse(input), input).toBe(out);
    }
  });

  it(`rejects ${EMAIL_INVALID.length} invalid addresses with the exact message`, () => {
    expect(EMAIL_INVALID.length).toBeGreaterThanOrEqual(15);
    for (const input of EMAIL_INVALID) {
      expect(normaliseEmail(input), input).toBeNull();
      expect(email.safeParse(input).error?.issues[0].message, input).toBe(EMAIL_MESSAGE);
    }
    expect(EMAIL_MESSAGE).toBe("Enter a valid email address.");
  });

  it("caps the length at 254 characters", () => {
    const local = "a".repeat(64);
    // 64 + 1 + 63 + 1 + 63 + 1 + 57 + 4 = 254 characters: the longest valid address; one more is too long.
    expect(normaliseEmail(`${local}@${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(57)}.com`)).toBe(`${local}@${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(57)}.com`);
    expect(normaliseEmail(`${local}@${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(58)}.com`)).toBeNull();
  });
});

describe("v5 CV-5 loginIdentifier", () => {
  beforeEach(productionRules);
  afterEach(() => vi.unstubAllEnvs());

  it(`accepts ${LOGIN_VALID.length} mobiles or emails and decides which by format`, () => {
    expect(LOGIN_VALID.length).toBeGreaterThanOrEqual(15);
    for (const [input, out] of LOGIN_VALID) {
      expect(classifyLoginIdentifier(input), input).toEqual(out);
      expect(loginIdentifier.parse(input), input).toBe(out.value);
    }
  });

  it(`rejects ${LOGIN_INVALID.length} values with the exact message`, () => {
    expect(LOGIN_INVALID.length).toBeGreaterThanOrEqual(15);
    for (const input of LOGIN_INVALID) {
      expect(classifyLoginIdentifier(input), input).toBeNull();
      expect(loginIdentifier.safeParse(input).error?.issues[0].message, input).toBe(LOGIN_IDENTIFIER_MESSAGE);
    }
    expect(LOGIN_IDENTIFIER_MESSAGE).toBe("Enter your registered mobile number or email.");
  });

  it("the login route also accepts member codes (v3 WK-2) and rejects anything else with the message", async () => {
    const { loginIdentifierField } = await import("@/server/auth/account");
    expect(loginIdentifierField.parse("CC-000123")).toBe("CC-000123");
    expect(loginIdentifierField.parse("cc000123")).toBe("cc000123");
    expect(loginIdentifierField.parse(" +91 98110 00001 ")).toBe("9811000001");
    expect(loginIdentifierField.parse("Desk@Test.Club")).toBe("desk@test.club");
    expect(loginIdentifierField.safeParse("hello").error?.issues[0].message).toBe(LOGIN_IDENTIFIER_MESSAGE);
  });
});

describe("v5 optional and clearable fields", () => {
  const s = z.object({ email: optionalContact(email), phone: optionalContact(mobilePhone), guardian: clearableContact(mobilePhone) });
  it("blank → absent (optional) / cleared (clearable); a value must be valid", () => {
    expect(s.parse({ email: "", phone: "  ", guardian: "" })).toEqual({ email: undefined, phone: undefined, guardian: null });
    expect(s.parse({})).toEqual({});
    expect(s.parse({ email: "A@B.CO", phone: "+91 98110 00001", guardian: "09811000002" })).toEqual({ email: "a@b.co", phone: "9811000001", guardian: "9811000002" });
    const bad = s.safeParse({ email: "a@b", phone: "123", guardian: "x" });
    expect(bad.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["email", EMAIL_MESSAGE],
      ["phone", MOBILE_MESSAGE],
      ["guardian", MOBILE_MESSAGE],
    ]);
  });
});

describe("v5 CV-7 test-only allowlist", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is active under the test runner, so existing fixtures stay valid", () => {
    expect(isTestAllowlistActive()).toBe(true);
    for (const n of TEST_ONLY_PHONES) expect(normaliseMobile(n)).toBe(n);
    expect(normaliseMobile("8888888888")).toBeNull(); // only the listed numbers
  });

  it("is off in production and for the seed unless it opts in", () => {
    productionRules();
    expect(isTestAllowlistActive()).toBe(false);
    expect(normaliseMobile("9876543210")).toBeNull();
    vi.stubEnv("CONTACTS_TEST_ALLOWLIST", "1");
    expect(normaliseMobile("9876543210")).toBe("9876543210");
  });

  it("is never active in a browser form", () => {
    vi.stubGlobal("window", {});
    try {
      expect(isTestAllowlistActive()).toBe(false);
      expect(normaliseMobile("9876543210")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("v5 CV-10 audit rule: phone / email inputs carry data-validate", () => {
  it("flags a raw phone or email input, accepts the shared ones, excludes search boxes", () => {
    expect(scanContactInputs(`<Field label="Mobile"><Input value={x} onChange={f} /></Field>`)).toMatchObject([{ verdict: "missing" }]);
    expect(scanContactInputs(`<Input type="email" value={x} />`)).toMatchObject([{ verdict: "missing" }]);
    expect(scanContactInputs(`<input name="guardianPhone" />`)).toMatchObject([{ verdict: "missing" }]);
    expect(scanContactInputs(`<label>Emergency phone <input value={p} /></label>`)).toMatchObject([{ verdict: "missing" }]);
    expect(scanContactInputs(`<Input placeholder="Name, phone or CC-000123" value={q} />`)).toMatchObject([{ verdict: "search" }]);
    expect(scanContactInputs(`<Input data-validate="phone" name="phone" />`)).toEqual([]);
    expect(scanContactInputs(`<Field label="Email"><Toggle /></Field><input type="checkbox" name="emailOptIn" />`)).toEqual([]);
    expect(classifyContactInput({ type: "tel" })).toBe("missing");
    expect(classifyContactInput({ type: "email", dataValidate: "email" })).toBe("ok");
    expect(classifyContactInput({ label: "Phone or email", dataValidate: "login" })).toBe("ok");
  });

  it("every phone / mobile / email input in src/ uses the shared inputs", () => {
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) for (const h of scanContactInputs(fs.readFileSync(p, "utf8"))) if (h.verdict === "missing") missing.push(`${p}:${h.line} ${h.text}`);
      }
    };
    walk(path.resolve(__dirname, "../../src"));
    expect(missing).toEqual([]);
  });
});
