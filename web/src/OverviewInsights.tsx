import { For, Show } from "solid-js";
import type { TopModelDto } from "./api";
import { Card, Icon, fmtNum } from "./ui";

const percent = (value: number) => value.toLocaleString("en", { maximumFractionDigits: 1 });

export function TopModelsCard(props: { models: TopModelDto[]; requests: number; label: string }) {
  const provider = (model: TopModelDto) => model.provider_name || model.provider_id || "Unknown provider";
  const share = (model: TopModelDto) => props.requests > 0 ? Math.min(100, model.reqs / props.requests * 100) : 0;
  return <Card class="overview-top-models p-5 min-w-0">
    <div class="overview-insight-heading">
      <div><h2>Top 5 models</h2><p>By requests · {props.label}</p></div>
      <Icon name="lucide:layers-2" size={17} class="text-ink-500" />
    </div>
    <Show when={props.models.length} fallback={<div class="top-models-empty"><Icon name="lucide:box" size={25} /><strong>No model activity</strong><span>Models used in this period will appear here.</span></div>}>
      <ol class="top-model-list" aria-label="Top models by request count">
        <For each={props.models}>{(model, index) => <li class="top-model-row" data-model={model.model}>
          <span class="top-model-rank" aria-label={`Rank ${index() + 1}`}>{String(index() + 1).padStart(2, "0")}</span>
          <div class="top-model-identity">
            <strong class="top-model-name" title={model.model_name}>{model.model_name}</strong>
            <span class="top-model-route" title={`by ${provider(model)} (${model.upstream_model || model.model})${model.route_count > 1 ? ` · Most used of ${model.route_count} routes` : ""}`}>
              by <span>{provider(model)}</span> <span class="top-model-upstream">({model.upstream_model || model.model})</span>
            </span>
            <Show when={model.route_count > 1}><span class="top-model-other-routes">+{model.route_count - 1} {model.route_count === 2 ? "route" : "routes"}</span></Show>
          </div>
          <div class="top-model-volume" title={`${model.reqs.toLocaleString()} requests · ${percent(share(model))}% of this period`}>
            <strong>{fmtNum(model.reqs)}</strong><span>{percent(share(model))}%</span>
            <div class="top-model-bar" aria-hidden="true"><i style={{ width: `${share(model)}%` }} /></div>
          </div>
        </li>}</For>
      </ol>
    </Show>
  </Card>;
}
