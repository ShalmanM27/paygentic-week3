"use client";

// Agent registration form. Submits to credit-agent's POST /agents/register,
// then redirects to /add-agent/[subscriptionId] where the rent checkout
// SDK mounts.

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { credit } from "../../lib/credit-client";
import { Button, Card, Section, Tag, USDC } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import type { RegisterAgentBody } from "../../lib/types";

const CATEGORIES = ["Text", "Engineering", "Creative", "Research"] as const;
const RENT_USDC = 0.005;

const AGENT_ID_RE = /^[a-z]+(-[a-z]+)*$/;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const SERVICE_URL_RE = /^https?:\/\/.+/;

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

export default function AddAgentPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validation = useMemo(() => validateForm(form), [form]);
  const canSubmit = validation.ok && !submitting;

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
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
    <main className="min-h-screen p-6 max-w-2xl mx-auto">
      <PageHeader
        rightSlot={
          <>
            <Link href="/" className="text-info text-sm hover:underline">
              ← Marketplace
            </Link>
            <Link href="/about" className="text-info text-sm hover:underline">
              About
            </Link>
          </>
        }
      />

      <header className="py-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Register a new agent
        </h1>
        <p className="mt-1 text-sm text-ink-dim">
          Get your AI service on the marketplace. Monthly hosting rent:{" "}
          <span className="text-accent">${RENT_USDC.toFixed(4)} USDC</span>.
        </p>
      </header>

      <Section title="About hosting">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card className="p-3 text-center">
            <USDC amount={RENT_USDC} className="text-base text-warn" />
            <div className="text-[10px] uppercase tracking-widest text-ink-dim mt-1">
              per month
            </div>
          </Card>
          <Card className="p-3 text-center text-sm">
            Pay via Locus Checkout
          </Card>
          <Card className="p-3 text-center text-sm">
            Active in seconds after payment
          </Card>
        </div>
      </Section>

      <Section title="Agent details">
        <Card className="p-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Agent ID"
              hint="lowercase-with-hyphens · e.g., image-creator"
              error={validation.errors.agentId}
            >
              <input
                value={form.agentId}
                onChange={(e) =>
                  update("agentId", e.target.value.toLowerCase())
                }
                placeholder="image-creator"
                className={inputCls}
              />
            </Field>
            <Field
              label="Display name"
              error={validation.errors.displayName}
            >
              <input
                value={form.displayName}
                onChange={(e) => update("displayName", e.target.value)}
                placeholder="Image Creator"
                className={inputCls}
              />
            </Field>
            <Field
              label="Description"
              hint={`${form.description.length} / 280 chars`}
              error={validation.errors.description}
            >
              <textarea
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder="Generates images from text prompts."
                rows={2}
                maxLength={280}
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <select
                  value={form.category}
                  onChange={(e) =>
                    update(
                      "category",
                      e.target.value as (typeof CATEGORIES)[number],
                    )
                  }
                  className={inputCls}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Emoji" error={validation.errors.emoji}>
                <input
                  value={form.emoji}
                  onChange={(e) => update("emoji", e.target.value)}
                  className={inputCls}
                  maxLength={8}
                />
              </Field>
            </div>
            <Field
              label="Pricing per task (USDC)"
              error={validation.errors.pricingUsdc}
            >
              <input
                type="number"
                value={form.pricingUsdc}
                onChange={(e) => update("pricingUsdc", e.target.value)}
                step="0.0001"
                min="0.001"
                max="1.0"
                className={inputCls}
              />
            </Field>
            <Field
              label="Operator name"
              error={validation.errors.operatorName}
            >
              <input
                value={form.operatorName}
                onChange={(e) => update("operatorName", e.target.value)}
                placeholder="Your name"
                className={inputCls}
              />
            </Field>
            <Field
              label="Operator email (for receipt)"
              error={validation.errors.operatorEmail}
            >
              <input
                type="email"
                value={form.operatorEmail}
                onChange={(e) => update("operatorEmail", e.target.value)}
                placeholder="you@example.com"
                className={inputCls}
              />
            </Field>
            <Field
              label="Service URL"
              hint="For hackathon: a placeholder is fine. Production needs a reachable /work-with-input endpoint."
              error={validation.errors.serviceUrl}
            >
              <input
                value={form.serviceUrl}
                onChange={(e) => update("serviceUrl", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field
              label="Wallet address"
              hint="0x + 40 hex chars · for hackathon, any valid format."
              error={validation.errors.walletAddress}
            >
              <input
                value={form.walletAddress}
                onChange={(e) => update("walletAddress", e.target.value)}
                className={inputCls + " font-mono-tight"}
              />
            </Field>
            <Field
              label="Capabilities"
              hint="One per line · displayed as bullets on the agent page."
              error={validation.errors.capabilities}
            >
              <textarea
                value={form.capabilities}
                onChange={(e) => update("capabilities", e.target.value)}
                placeholder={"Generates 512×512 images\nMultiple style presets\n2-3s per request"}
                rows={4}
                className={inputCls}
              />
            </Field>

            {submitError && (
              <div className="text-sm text-danger">{submitError}</div>
            )}

            <Button
              type="submit"
              disabled={!canSubmit}
              size="lg"
              className="w-full"
            >
              {submitting
                ? "Creating subscription…"
                : `Register & pay $${RENT_USDC.toFixed(4)} rent`}
            </Button>
          </form>
        </Card>
      </Section>

      <Section title="Why hosting rent?">
        <Card className="p-4 text-xs text-ink-dim leading-relaxed">
          Rent revenue funds the credit platform. It also acts as a spam
          filter — operators must commit USDC to host. Coverage period is{" "}
          <Tag variant="default">30 days</Tag>; renewal flow ships in a
          future iteration.
        </Card>
      </Section>
    </main>
  );
}

const inputCls =
  "w-full bg-panel-cardHover border border-panel-borderStrong rounded p-2 text-sm text-ink placeholder:text-ink-dimmer focus:outline-none focus:border-accent/50";

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
    <div>
      <label className="block text-xs uppercase tracking-widest text-ink-dim mb-1.5">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[11px] text-danger mt-1">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-ink-dimmer mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

function validateForm(f: FormState): {
  ok: boolean;
  errors: Partial<Record<keyof FormState, string>>;
} {
  const errors: Partial<Record<keyof FormState, string>> = {};
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
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.operatorEmail))
    errors.operatorEmail = "looks invalid";
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
