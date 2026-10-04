"use client";
// v5 §2.2 shared phone / email inputs (CV-8). Every phone, mobile and email field in the app renders through these,
// so the client checks with the same functions the server uses (src/lib/validation/contact.ts; the server decides).
// - Validation on blur and on submit; no error while the field is being typed for the first time. Once shown, the
//   message updates as the user types and clears as soon as the value is valid.
// - On submit the browser's constraint validation blocks a native <form> (setCustomValidity); `invalid` shows the
//   inline message instead of the browser bubble. Forms that save from a button call checkContactInputs(root).
// - Phones: type="tel", inputMode="numeric", autoComplete="tel", a visible +91 for mobiles. Emails: type="email",
//   autoComplete="email". Each input carries data-validate="phone" | "email" | "login" (checked by the source audit).
import * as React from "react";
import { ApiError } from "./api";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import {
  CONTACT_PHONE_MESSAGE,
  EMAIL_MESSAGE,
  LOGIN_IDENTIFIER_MESSAGE,
  MOBILE_MESSAGE,
  classifyLoginIdentifier,
  normaliseContactPhone,
  normaliseEmail,
  normaliseMobile,
} from "@/lib/validation/contact";

type BaseProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Classes for the wrapper (width in inline rows); `className` styles the <input>. */
  wrapperClassName?: string;
};

export type PhoneInputProps = BaseProps & { kind?: "mobile" | "contact" };
export type EmailInputProps = BaseProps;
export type LoginIdentifierInputProps = BaseProps & { allowMemberCode?: boolean };

/** v3 WK-2: a member may also log in with their member code (CC-000123). Mirrors findUserByIdentifier. */
export const MEMBER_CODE_PATTERN = /^[A-Za-z]{2,4}-?\d{3,}$/;

/**
 * Submit-time check for forms that save from a button instead of a native submit: shows the inline message on every
 * invalid contact input inside `root` (or `root` itself when it is one) and returns false when any is invalid.
 */
export function checkContactInputs(root: ParentNode | null | undefined = typeof document === "undefined" ? null : document): boolean {
  if (!root) return true;
  const self = (root as Element).matches?.("input[data-validate]") ? [root as HTMLInputElement] : [];
  let ok = true;
  for (const el of [...self, ...Array.from(root.querySelectorAll<HTMLInputElement>("input[data-validate]"))]) {
    if (!el.checkValidity()) ok = false;
  }
  return ok;
}

/** As checkContactInputs, but throws (for save handlers that report errors by throwing, e.g. Settings' SaveBar). */
export function requireContactInputs(root: ParentNode | null | undefined): void {
  if (!checkContactInputs(root)) throw new ApiError("VALIDATION_FAILED", "Please correct the highlighted phone or email.", 422, null);
}

type Rule = { validate: "phone" | "email" | "login"; isValid: (v: string) => boolean; message: string };

const ValidatedInput = React.forwardRef<HTMLInputElement, BaseProps & { rule: Rule; prefix?: string; htmlType: "tel" | "email" | "text"; defaults: React.InputHTMLAttributes<HTMLInputElement> }>(
  function ValidatedInput({ rule, prefix, htmlType, defaults, wrapperClassName, className, onBlur, onChange, onInvalid, ...props }, ref) {
    const inner = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => inner.current as HTMLInputElement, []);
    const autoId = React.useId();
    const errId = `${props.id ?? autoId}-error`;
    const controlled = props.value !== undefined;
    const [own, setOwn] = React.useState(String(props.defaultValue ?? ""));
    const value = controlled ? String(props.value ?? "") : own;
    const blank = value.trim() === "";
    const bad = blank ? !!props.required : !rule.isValid(value);
    // touched: blurred with something typed (or submitted); forced: the browser reported it invalid on submit.
    const [touched, setTouched] = React.useState(false);
    const [forced, setForced] = React.useState(false);
    const [prevBlank, setPrevBlank] = React.useState(blank);
    if (prevBlank !== blank) {
      setPrevBlank(blank);
      // Cleared (by the user or after a successful save): the next first-time typing starts quiet again.
      if (blank && touched) setTouched(false);
    }
    const showError = bad && ((touched && !blank) || forced);

    React.useEffect(() => {
      inner.current?.setCustomValidity(bad ? rule.message : "");
    }, [bad, rule.message]);

    const input = (
      <Input
        {...defaults}
        {...props}
        ref={inner}
        type={htmlType}
        data-validate={rule.validate}
        aria-invalid={showError || undefined}
        aria-describedby={[props["aria-describedby"], showError ? errId : null].filter(Boolean).join(" ") || undefined}
        className={cn(prefix && "pl-12", showError && "border-destructive focus-visible:ring-destructive", className)}
        onChange={(e) => {
          if (!controlled) setOwn(e.target.value);
          if (forced) setForced(false);
          onChange?.(e);
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim() !== "") setTouched(true);
          onBlur?.(e);
        }}
        onInvalid={(e) => {
          e.preventDefault(); // the inline message replaces the browser bubble
          setTouched(true);
          setForced(true);
          onInvalid?.(e);
        }}
      />
    );
    return (
      <span className={cn("flex w-full flex-col gap-1", wrapperClassName)}>
        {prefix ? (
          <span className="relative flex w-full items-center">
            {/* The +91 is drawn by CSS (no text node), so the field's label stays exactly its own text for screen
                readers and label-based selectors. */}
            <span aria-hidden="true" data-prefix={prefix} className="pointer-events-none absolute left-3 text-sm font-medium text-muted-foreground before:content-['+91']" />
            {input}
          </span>
        ) : (
          input
        )}
        {showError ? (
          // aria-hidden keeps the field's accessible name stable; screen readers get it through aria-describedby.
          <span id={errId} aria-hidden="true" className="text-xs font-medium text-destructive" data-testid="contact-error">
            {rule.message}
          </span>
        ) : null}
      </span>
    );
  },
);

const MOBILE_RULE: Rule = { validate: "phone", isValid: (v) => normaliseMobile(v) !== null, message: MOBILE_MESSAGE };
const CONTACT_RULE: Rule = { validate: "phone", isValid: (v) => normaliseContactPhone(v) !== null, message: CONTACT_PHONE_MESSAGE };
const EMAIL_RULE: Rule = { validate: "email", isValid: (v) => normaliseEmail(v) !== null, message: EMAIL_MESSAGE };
const LOGIN_RULE: Rule = { validate: "login", isValid: (v) => classifyLoginIdentifier(v) !== null, message: LOGIN_IDENTIFIER_MESSAGE };
const LOGIN_OR_CODE_RULE: Rule = { ...LOGIN_RULE, isValid: (v) => classifyLoginIdentifier(v) !== null || MEMBER_CODE_PATTERN.test(v.trim()) };

const PHONE_DEFAULTS = { inputMode: "numeric", autoComplete: "tel" } as const;

/** CV-1/CV-3: a person's mobile (kind="mobile", default, with a visible +91) or a club/business phone (kind="contact"). */
export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(function PhoneInput({ kind = "mobile", ...props }, ref) {
  return kind === "contact" ? (
    <ValidatedInput ref={ref} rule={CONTACT_RULE} htmlType="tel" defaults={PHONE_DEFAULTS} {...props} />
  ) : (
    <ValidatedInput ref={ref} rule={MOBILE_RULE} prefix="+91" htmlType="tel" defaults={PHONE_DEFAULTS} {...props} />
  );
});

/** CV-4: an email address. */
export const EmailInput = React.forwardRef<HTMLInputElement, EmailInputProps>(function EmailInput(props, ref) {
  return <ValidatedInput ref={ref} rule={EMAIL_RULE} htmlType="email" defaults={{ autoComplete: "email" }} {...props} />;
});

/** CV-5: login / password-reset identifier — a mobile or an email (and a member code where `allowMemberCode`). */
export const LoginIdentifierInput = React.forwardRef<HTMLInputElement, LoginIdentifierInputProps>(function LoginIdentifierInput({ allowMemberCode = true, ...props }, ref) {
  return <ValidatedInput ref={ref} rule={allowMemberCode ? LOGIN_OR_CODE_RULE : LOGIN_RULE} htmlType="text" defaults={{ autoComplete: "username", autoCapitalize: "none", spellCheck: false }} {...props} />;
});
