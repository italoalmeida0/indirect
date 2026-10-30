import { createSignal, Show } from "solid-js";
import { PageTitle } from "../../chrome";
import { Select } from "../../ui";
import { FinancialDefaults, ModelPolicies } from "./FinancialPolicies";
import CorporateAuth from "./CorporateAuth";
import UserImport from "./UserImport";
import Operations from "./Operations";

export default function OrganizationPage() {
  const [section, setSection] = createSignal("financial");
  return <div class="space-y-5"><PageTitle title="Organization" subtitle="Optional controls for teams. Defaults keep local use simple." /><div class="max-w-md"><Select label="Organization settings" value={section()} onChange={setSection} options={[{ value: "financial", label: "Financial visibility" }, { value: "models", label: "Model access policies" }, { value: "identity", label: "Corporate authentication" }, { value: "import", label: "Bulk user import" }, { value: "operations", label: "Operations and backups" }]} /></div><Show when={section() === "financial"}><FinancialDefaults /></Show><Show when={section() === "models"}><ModelPolicies /></Show><Show when={section() === "identity"}><CorporateAuth /></Show><Show when={section() === "import"}><UserImport /></Show><Show when={section() === "operations"}><Operations /></Show></div>;
}
