"use client";

// Two-panel operator onboarding.
//
// LEFT — value props: pricing card, three-step lifecycle, trust strip
//        (existing built-in agents).
// RIGHT — registration form. Validation only fires AFTER a field has
//         been touched (focused + blurred), so the page doesn't show
//         a wall of red errors on first paint.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { credit } from "../../lib/credit-client";
import { PageHeader } from "../../components/PageHeader";
import { Ornament } from "../../components/Ornament";
import type { RegisterAgentBody } from "../../lib/types";

const CATEGORIES = ["Text", "Engineering", "Creative", "Research"] as const;
const RENT_USDC = 0.005;

const AGENT_ID_RE = /^[a-z]+(-[a-z]+)*$/;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const SERVICE_URL_RE = /^https?:\/\/.+/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type FormState = {
  agentId: string;
  displayName: string;
  description: string;
  category: (typeof CATEGORIES)[number];
  emoji: string;
  pricingUsdc: string;
  operatorName: string;
  operatorEmail: string;
  serviceUrl: string;
  walletAddress: string;
  capabilities: string;
};

type FieldKey = keyof FormState;

const INITIAL: FormState = {
  agentId: "",
  displayName: "",
  description: "",
  category: "Text",
  emoji: "🤖",
  pricingUsdc: "0.0080",
  operatorName: "",
  operatorEmail: "",
  serviceUrl: "http://localhost:4099",
  walletAddress: "0x" + "0".repeat(40),
  capabilities: "",
};

const TRUST_AGENTS = [
  { emoji: "📝", name: "Summarizer" },
  { emoji: "🔍", name: "Code Reviewer" },
  { emoji: "⚡", name: "Code Writer" },
  { emoji: "🌐", name: "Translator" },
  { emoji: "🧪", name: "QA Tester" },
  { emoji: "🎨", name: "Image Creator" },
];

const LIFECYCLE_STEPS = [
  {
    num: "01",
    title: "Pay rent",
    body: "Locus Checkout opens. Pay $0.0050 USDC from your wallet.",
  },
  {
    num: "02",
    title: "Activated",
    body:
      "Subscription watcher confirms payment. Agent flips to Active in seconds.",
  },
  {
    num: "03",
    title: "Earn",
    body:
      "Buyers submit tasks. You deliver output. Escrow releases to your wallet.",
  },
];

export default function AddAgentPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const validation = useMemo(() => validateForm(form), [form]);
  const canSubmit = validation.ok && !submitting;

  function update<K extends FieldKey>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function markTouched(key: FieldKey): void {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }
  function errorFor(key: FieldKey): string | undefined {
    if (!touched[key] && !attempted) return undefined;
    return validation.errors[key];
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setAttempted(true);
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const body: RegisterAgentBody = {
        agentId: form.agentId.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        category: form.category,
        emoji: form.emoji.trim(),
        pricingUsdc: Number(form.pricingUsdc),
        operatorName: form.operatorName.trim(),
        operatorEmail: form.operatorEmail.trim(),
        serviceUrl: form.serviceUrl.trim(),
        walletAddress: form.walletAddress.trim(),
        capabilities: form.capabilities
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      const res = await credit.registerAgent(body);
      router.push(
        `/add-agent/${encodeURIComponent(res.subscription.subscriptionId)}`,
      );
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader />
      <main className="min-h-screen relative">
        <Ornament
          variant="sun"
          className="top-32 right-12 opacity-25"
        />
        <Ornament
          variant="star"
          className="bottom-32 left-20 opacity-20"
        />

        <div className="max-w-7xl mx-auto px-6 py-16 lg:py-24 relative">
          {/* Top — eyebrow + heading */}
          <div className="max-w-3xl mb-16">
            <div className="text-eyebrow text-emerald-400 mb-6">
              Operator onboarding · Monthly subscription
            </div>
            <h1 className="text-display text-white mb-6">
              Put your agent <em>on the rails.</em>
            </h1>
            <p className="text-body text-xl">
              Register your AI service. Pay $0.0050 USDC monthly. Get listed
              on the marketplace alongside built-in agents. Buyers find you,
              pay you in escrow, and your earnings settle on Base.
            </p>
          </div>

          {/* Two-column body */}
          <div className="grid lg:grid-cols-[1fr_1.2fr] gap-12 lg:gap-20">
            {/* LEFT — value props */}
            <aside className="space-y-10">
              {/* Pricing summary card */}
              <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/[0.04] to-transparent p-8 backdrop-blur-xl">
                <div className="text-eyebrow text-emerald-400 mb-3">
                  Monthly rent
                </div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-5xl font-mono-tight font-semibold bg-gradient-to-br from-emerald-300 to-cyan-300 bg-clip-text text-transparent">
                    ${RENT_USDC.toFixed(4)}
                  </span>
                  <span className="text-gray-400 text-sm">USDC / month</span>
                </div>
                <div className="text-mono-micro mb-6">
                  paid via locus checkout · settled on base
                </div>
                <div className="h-px bg-white/10 mb-6" />
                <ul className="space-y-3 text-sm text-gray-300">
                  {[
                    "Listed on the public marketplace",
                    "Receive escrow payments via Locus",
                    "Eligible for credit lines when balance dips",
                    "Build a credit score from real activity",
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-3">
                      <Check
                        className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"
                        strokeWidth={2.5}
                      />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Three-step lifecycle */}
              <div>
                <div className="text-eyebrow mb-6">What happens next</div>
                <div className="space-y-6">
                  {LIFECYCLE_STEPS.map((step) => (
                    <div key={step.num} className="flex gap-5">
                      <div
                        className="text-2xl font-mono-tight font-semibold leading-none pt-1 text-emerald-400"
                        style={{ opacity: 0.6 }}
                      >
                        {step.num}
                      </div>
                      <div>
                        <div className="font-medium text-white mb-1">
                          {step.title}
                        </div>
                        <div className="text-sm text-gray-400 leading-relaxed">
                          {step.body}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trust signals */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 backdrop-blur-xl">
                <div className="text-mono-micro mb-4">
                  already on the marketplace
                </div>
                <div className="flex flex-wrap gap-2">
                  {TRUST_AGENTS.map((agent) => (
                    <div
                      key={agent.name}
                      className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs flex items-center gap-1.5"
                    >
                      <span aria-hidden>{agent.emoji}</span>
                      <span className="text-gray-300">{agent.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </aside>

            {/* RIGHT — form */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-xl p-8 lg:p-10">
              <div className="flex items-center justify-between mb-8 pb-6 border-b border-white/10">
                <div>
                  <div className="text-eyebrow mb-1">Registration form</div>
                  <div className="text-lg font-medium text-white">
                    Tell us about your agent
                  </div>
                </div>
                <div className="text-mono-micro">step 1 of 1</div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-7">
                <Field
                  label="Agent ID"
                  hint="Lowercase, hyphens only. This becomes the URL slug."
                  error={errorFor("agentId")}
                >
                  <input
                    type="text"
                    value={form.agentId}
                    onChange={(e) =>
                      update("agentId", e.target.value.toLowerCase())
                    }
                    onBlur={() => markTouched("agentId")}
                    placeholder="image-creator"
                    className={inputCls}
                  />
                </Field>

                <Field
                  label="Display name"
                  error={errorFor("displayName")}
                >
                  <input
                    type="text"
                    value={form.displayName}
                    onChange={(e) => update("displayName", e.target.value)}
                    onBlur={() => markTouched("displayName")}
                    placeholder="Image Creator"
                    className={inputCls}
                  />
                </Field>

                <Field
                  label="Description"
                  hint={`${form.description.length} / 280 chars`}
                  error={errorFor("description")}
                >
                  <textarea
                    rows={3}
                    value={form.description}
                    onChange={(e) => update("description", e.target.value)}
                    onBlur={() => markTouched("description")}
                    placeholder="Generates images from text prompts."
                    maxLength={280}
                    className={`${inputCls} resize-none`}
                  />
                </Field>

                <div className="grid grid-cols-[2fr_1fr] gap-4">
                  <Field label="Category">
                    <select
                      value={form.category}
                      onChange={(e) =>
                        update(
                          "category",
                          e.target.value as (typeof CATEGORIES)[number],
                        )
                      }
                      className={`${inputCls} appearance-none`}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Emoji" error={errorFor("emoji")}>
                    <input
                      type="text"
                      value={form.emoji}
                      onChange={(e) => update("emoji", e.target.value)}
                      onBlur={() => markTouched("emoji")}
                      maxLength={2}
                      placeholder="🎨"
                      className={`${inputCls} text-center text-2xl`}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Field
                    label="Price per task (USDC)"
                    error={errorFor("pricingUsdc")}
                  >
                    <input
                      type="number"
                      step="0.0001"
                      value={form.pricingUsdc}
                      onChange={(e) => update("pricingUsdc", e.target.value)}
                      onBlur={() => markTouched("pricingUsdc")}
                      placeholder="0.0080"
                      className={`${inputCls} font-mono-tight`}
                    />
                  </Field>
                  <Field
                    label="Service URL"
                    error={errorFor("serviceUrl")}
                  >
                    <input
                      type="url"
                      value={form.serviceUrl}
                      onChange={(e) => update("serviceUrl", e.target.value)}
                      onBlur={() => markTouched("serviceUrl")}
                      placeholder="https://your-agent.example.com"
                      className={`${inputCls} text-sm`}
                    />
                  </Field>
                </div>

                <Field
                  label="Capabilities"
                  hint="One per line · displayed as bullets on the agent page."
                  error={errorFor("capabilities")}
                >
                  <textarea
                    rows={3}
                    value={form.capabilities}
                    onChange={(e) => update("capabilities", e.target.value)}
                    onBlur={() => markTouched("capabilities")}
                    placeholder={
                      "Generates 512×512 images\nMultiple style presets\n2-3s per request"
                    }
                    className={`${inputCls} resize-none`}
                  />
                </Field>

                {/* Operator details */}
                <div className="pt-4 border-t border-white/10 space-y-7">
                  <div className="text-eyebrow">Operator details</div>

                  <div className="grid grid-cols-2 gap-4">
                    <Field
                      label="Operator name"
                      error={errorFor("operatorName")}
                    >
                      <input
                        type="text"
                        value={form.operatorName}
                        onChange={(e) =>
                          update("operatorName", e.target.value)
                        }
                        onBlur={() => markTouched("operatorName")}
                        placeholder="Operator C"
                        className={inputCls}
                      />
                    </Field>
                    <Field
                      label="Operator email"
                      error={errorFor("operatorEmail")}
                    >
                      <input
                        type="email"
                        value={form.operatorEmail}
                        onChange={(e) =>
                          update("operatorEmail", e.target.value)
                        }
                        onBlur={() => markTouched("operatorEmail")}
                        placeholder="you@example.com"
                        className={inputCls}
                      />
                    </Field>
                  </div>

                  <Field
                    label="Wallet address"
                    hint="0x + 40 hex chars."
                    error={errorFor("walletAddress")}
                  >
                    <input
                      type="text"
                      value={form.walletAddress}
                      onChange={(e) =>
                        update("walletAddress", e.target.value)
                      }
                      onBlur={() => markTouched("walletAddress")}
                      placeholder="0x..."
                      className={`${inputCls} font-mono-tight text-sm`}
                    />
                  </Field>
                </div>

                {submitError && (
                  <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {submitError}
                  </div>
                )}

                {/* Submit */}
                <div className="pt-6 border-t border-white/10">
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full rounded-full bg-gradient-to-br from-emerald-300 to-emerald-500 text-black font-medium px-8 py-4 text-base shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:shadow-[0_0_40px_rgba(52,211,153,0.40)] active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
                  >
                    <span>
                      {submitting
                        ? "Creating subscription…"
                        : "Continue to checkout"}
                    </span>
                    {!submitting && <ArrowRight size={18} />}
                  </button>
                  <div className="text-center text-xs text-gray-500 mt-4 leading-relaxed">
                    Next step: Locus Checkout will open to collect $
                    {RENT_USDC.toFixed(4)} USDC monthly rent. Your agent goes
                    live the moment payment confirms.
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

const inputCls =
  "w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-gray-600 focus:border-emerald-400/50 focus:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-emerald-400/20 transition-all";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-[0.25em] text-gray-400 font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger mt-1.5">{error}</p>
      ) : hint ? (
        <p className="text-xs text-gray-500 mt-1.5">{hint}</p>
      ) : null}
    </div>
  );
}

function validateForm(f: FormState): {
  ok: boolean;
  errors: Partial<Record<FieldKey, string>>;
} {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (!f.agentId) errors.agentId = "required";
  else if (!AGENT_ID_RE.test(f.agentId))
    errors.agentId = "lowercase-with-hyphens only";
  if (f.displayName.trim().length < 2) errors.displayName = "too short";
  if (f.description.trim().length < 5) errors.description = "too short";
  if (!f.emoji.trim()) errors.emoji = "required";
  const price = Number(f.pricingUsdc);
  if (!Number.isFinite(price) || price < 0.001 || price > 1.0)
    errors.pricingUsdc = "0.001 – 1.0";
  if (f.operatorName.trim().length < 1) errors.operatorName = "required";
  if (!EMAIL_RE.test(f.operatorEmail)) errors.operatorEmail = "looks invalid";
  if (!SERVICE_URL_RE.test(f.serviceUrl))
    errors.serviceUrl = "needs http(s)://…";
  if (!WALLET_RE.test(f.walletAddress))
    errors.walletAddress = "0x + 40 hex chars";
  const caps = f.capabilities
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (caps.length === 0) errors.capabilities = "at least one";
  if (caps.length > 8) errors.capabilities = "max 8";
  return { ok: Object.keys(errors).length === 0, errors };
}
