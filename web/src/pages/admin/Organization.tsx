import { For, Match, Switch, createSignal } from "solid-js";
import { PageTitle } from "../../chrome";
import { Icon } from "../../ui";
import { FinancialDefaults, ModelPolicies } from "./FinancialPolicies";
import CorporateAuth from "./CorporateAuth";
import UserImport from "./UserImport";
import Operations from "./Operations";

interface OrganizationSection {
  id: string;
  label: string;
  hint: string;
  icon: string;
}

const SECTIONS: OrganizationSection[] = [
  {
    id: "financial",
    label: "Financial visibility",
    hint: "Budget presentation and model price display",
    icon: "lucide:wallet",
  },
  {
    id: "models",
    label: "Model access policies",
    hint: "Default access and per-project grants",
    icon: "lucide:list-checks",
  },
  {
    id: "identity",
    label: "Corporate authentication",
    hint: "OpenID Connect, SSO and admin MFA",
    icon: "lucide:shield-check",
  },
  {
    id: "import",
    label: "Bulk user import",
    hint: "Preview and commit accounts from CSV or JSON",
    icon: "lucide:upload",
  },
  {
    id: "operations",
    label: "Operations & backups",
    hint: "Runtime metrics, maintenance and snapshots",
    icon: "lucide:database-backup",
  },
];

/**
 * Installation-wide administration. The section rail keeps every panel one
 * click away and in the operator's field of view; the previous single select
 * hid four of the five panels behind an unlabeled dropdown.
 */
export default function OrganizationPage() {
  const [section, setSection] = createSignal(SECTIONS[0]!.id);
  const active = () => SECTIONS.find((item) => item.id === section()) ?? SECTIONS[0]!;
  return (
    <div class="org-page">
      <PageTitle
        title="Organization"
        subtitle="Installation-wide defaults for finances, model access, corporate identity and operations."
      />
      <div class="org-hub">
        <nav class="org-hub-nav" aria-label="Organization sections">
          <For each={SECTIONS}>
            {(item) => (
              <button
                type="button"
                class="org-hub-link"
                aria-current={section() === item.id ? "true" : undefined}
                onClick={() => setSection(item.id)}
              >
                <span class="org-hub-link-icon" aria-hidden="true">
                  <Icon name={item.icon} size={16} />
                </span>
                <span class="org-hub-link-copy">
                  <span class="org-hub-link-title">{item.label}</span>
                  <span class="org-hub-link-hint">{item.hint}</span>
                </span>
                <Icon
                  name="lucide:chevron-right"
                  size={14}
                  class="org-hub-link-chevron"
                />
              </button>
            )}
          </For>
        </nav>
        <section class="org-hub-content" aria-label={active().label}>
          <Switch>
            <Match when={section() === "financial"}>
              <FinancialDefaults />
            </Match>
            <Match when={section() === "models"}>
              <ModelPolicies />
            </Match>
            <Match when={section() === "identity"}>
              <CorporateAuth />
            </Match>
            <Match when={section() === "import"}>
              <UserImport />
            </Match>
            <Match when={section() === "operations"}>
              <Operations />
            </Match>
          </Switch>
        </section>
      </div>
    </div>
  );
}
