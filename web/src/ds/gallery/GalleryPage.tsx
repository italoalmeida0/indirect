import { createSignal, For } from "solid-js";
import { PageTitle } from "../../chrome";
import {
  ACCENTS,
  Alert,
  Badge,
  Btn,
  Calendar,
  Card,
  Checkbox,
  Collapse,
  ConfirmButton,
  CopyButton,
  DatePicker,
  Drawer,
  EmptyState,
  Icon,
  IconBtn,
  Icons,
  Input,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Modal,
  Progress,
  RangeCalendar,
  RollingNumber,
  Segmented,
  Select,
  Shimmer,
  Skeleton,
  Switch,
  SwitchCard,
  TabPanel,
  Tabs,
  Textarea,
  TimePicker,
  Tooltip,
  accent,
  setAccent,
  setThemeMode,
  themeMode,
  toast,
  type AccentName,
  type ThemeMode,
} from "../../ui";
import { reducedMotion, setReducedMotionOverride } from "../motion/reduced";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "high-contrast", label: "High contrast" },
  { value: "system", label: "System" },
];

const DENSITY_OPTIONS = [
  { value: "default" as const, label: "Default (Arc)" },
  { value: "compact" as const, label: "Compact (Workspace)" },
];

const MOTION_OPTIONS = [
  { value: "off" as const, label: "Full motion" },
  { value: "on" as const, label: "Reduced motion" },
];

const SEGMENT_DEMO = [
  { value: "overview", label: "Overview", badge: 4 },
  { value: "routing", label: "Routing", badge: 12 },
  { value: "security", label: "Security" },
];

const TAB_DEMO = [
  { value: "curl", label: "cURL", icon: Icons.terminal },
  { value: "ts", label: "TypeScript", icon: Icons.code },
  { value: "py", label: "Python", icon: Icons.sparkles },
];

const MODEL_OPTIONS = [
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", hint: "Anthropic" },
  { value: "gpt-5", label: "GPT-5", hint: "OpenAI" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Google" },
  { value: "deepseek-r1", label: "DeepSeek R1", hint: "DeepSeek" },
];

export default function GalleryPage() {
  const [density, setDensity] = createSignal<"default" | "compact">("default");
  const [btnLoading, setBtnLoading] = createSignal(false);
  const [btnLabelIndex, setBtnLabelIndex] = createSignal(0);
  const [counter, setCounter] = createSignal(14820);
  const [seg, setSeg] = createSignal("overview");
  const [tab, setTab] = createSignal("curl");
  const [selectedModel, setSelectedModel] = createSignal("claude-sonnet-4-5");
  const [inputVal, setInputVal] = createSignal("sk-ind-demo-key-98a7bc");
  const [notesVal, setNotesVal] = createSignal("");
  const [switchOn, setSwitchOn] = createSignal(true);
  const [checkOn, setCheckOn] = createSignal(true);
  const [progressVal, setProgressVal] = createSignal(68);
  const [collapseOpen, setCollapseOpen] = createSignal(true);
  const [modalOpen, setModalOpen] = createSignal(false);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<HTMLButtonElement>();
  const [pickedDate, setPickedDate] = createSignal<Date | undefined>(new Date(2026, 10, 10));
  const [pickedTime, setPickedTime] = createSignal("14:30");
  const [rangeFrom, setRangeFrom] = createSignal("2026-11-04T00:00");
  const [rangeTo, setRangeTo] = createSignal("2026-11-18T23:59");

  const btnLabels = ["Save changes", "Publishing configuration…", "Saved to gateway"];

  const toggleDensity = (next: "default" | "compact") => {
    setDensity(next);
    if (next === "compact") {
      document.documentElement.dataset.density = "compact";
    } else {
      delete document.documentElement.dataset.density;
    }
  };

  return (
    <div class="space-y-6" data-testid="ds-gallery">
      <PageTitle
        title="Design system gallery"
        subtitle="Interactive showcase of tokens, themes, spring physics and accessible SolidJS primitives"
      />

      {/* Environment controls */}
      <Card class="p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 class="text-base font-medium text-fg">Environment & tokens</h2>
            <p class="text-xs text-fg-secondary mt-0.5">
              Switch themes, oklch accents, corner radius density and motion preferences live.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Segmented
              value={themeMode()}
              onChange={(v) => setThemeMode(v)}
              options={THEME_OPTIONS}
              ariaLabel="Theme mode"
            />
            <Segmented
              value={density()}
              onChange={toggleDensity}
              options={DENSITY_OPTIONS}
              ariaLabel="Density mode"
            />
            <Segmented
              value={reducedMotion() ? "on" : "off"}
              onChange={(v) => setReducedMotionOverride(v === "on")}
              options={MOTION_OPTIONS}
              ariaLabel="Motion preference"
            />
          </div>
        </div>

        <div class="pt-3 border-t border-line flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-fg-secondary mr-2">Accent palette:</span>
          <For each={ACCENTS}>
            {(item) => (
              <button
                type="button"
                onClick={() => setAccent(item.id as AccentName)}
                aria-pressed={accent() === item.id}
                class={`inline-flex items-center gap-2 h-8 px-3 rounded-pill text-xs font-medium border transition-colors cursor-pointer ${
                  accent() === item.id
                    ? "border-accent bg-accent-subtle text-accent-strong"
                    : "border-line bg-surface text-fg-secondary hover:text-fg"
                }`}
              >
                <span
                  class="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: item.swatch }}
                />
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Card>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Buttons & Micro-interactions */}
        <Card class="p-5 space-y-4">
          <div>
            <h2 class="text-base font-medium text-fg">Buttons & tactile press</h2>
            <p class="text-xs text-fg-secondary mt-0.5">
              Width-aware press scale, smooth width morphing on label/spinner changes, and inline confirmation.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            <Btn variant="primary">Primary action</Btn>
            <Btn variant="secondary">Secondary</Btn>
            <Btn variant="outline">Outline</Btn>
            <Btn variant="subtle">Subtle</Btn>
            <Btn variant="ghost">Ghost</Btn>
            <Btn variant="danger">Danger</Btn>
          </div>

          <div class="pt-3 border-t border-line flex flex-wrap items-center gap-2.5">
            <Btn
              variant="primary"
              loading={btnLoading()}
              onClick={() => {
                setBtnLoading(true);
                setTimeout(() => {
                  setBtnLoading(false);
                  setBtnLabelIndex((i) => (i + 1) % btnLabels.length);
                }, 900);
              }}
            >
              {btnLabels[btnLabelIndex()]}
            </Btn>

            <ConfirmButton
              label="Revoke key"
              confirmLabel="Confirm revoke"
              onConfirm={() => toast.success("Key revoked")}
            />

            <CopyButton text="sk-ind-demo-key-98a7bc" label="Copy key" />

            <Tooltip content="Quick action with 500ms sibling warm window">
              <IconBtn icon={Icons.sparkles} label="Sparkles" />
            </Tooltip>
            <Tooltip content="Instant follow-up tooltip">
              <IconBtn icon={Icons.cog} label="Settings" />
            </Tooltip>
          </div>
        </Card>

        {/* RollingNumber & Shimmer */}
        <Card class="p-5 space-y-4">
          <div>
            <h2 class="text-base font-medium text-fg">Rolling numbers & status shimmer</h2>
            <p class="text-xs text-fg-secondary mt-0.5">
              Per-digit vertical reels on <code class="font-mono text-xs">spring.morph</code> with tabular alignment.
            </p>
          </div>

          <div class="flex flex-wrap items-baseline justify-between gap-4 p-4 rounded-control bg-surface-muted border border-line-subtle">
            <div>
              <div class="text-xs text-fg-secondary">Total requests routed</div>
              <div class="text-3xl font-medium text-fg tracking-tight mt-1">
                <RollingNumber value={counter()} format={(n) => n.toLocaleString("en-US")} />
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Btn size="sm" variant="outline" onClick={() => setCounter((c) => c + 1)}>
                +1
              </Btn>
              <Btn size="sm" variant="outline" onClick={() => setCounter((c) => c + 250)}>
                +250
              </Btn>
              <Btn size="sm" variant="outline" onClick={() => setCounter((c) => Math.max(0, c - 42))}>
                -42
              </Btn>
            </div>
          </div>

          <div class="pt-2 space-y-2">
            <div class="flex items-center justify-between text-xs text-fg-secondary">
              <Shimmer>Synthesizing upstream provider telemetry…</Shimmer>
              <span>{progressVal()}%</span>
            </div>
            <Progress value={progressVal()} label="Telemetry progress" />
            <div class="flex items-center gap-2 pt-1">
              <Btn size="xs" variant="ghost" onClick={() => setProgressVal((p) => Math.max(0, p - 15))}>
                Decrease
              </Btn>
              <Btn size="xs" variant="ghost" onClick={() => setProgressVal((p) => Math.min(100, p + 15))}>
                Increase
              </Btn>
            </div>
          </div>
        </Card>

        {/* Gliding navigation & disclosure */}
        <Card class="p-5 space-y-4">
          <div>
            <h2 class="text-base font-medium text-fg">Gliding indicators & disclosure</h2>
            <p class="text-xs text-fg-secondary mt-0.5">
              Shared <code class="font-mono text-xs">createGlide</code> highlight pill across segmented controls, tabs and menus.
            </p>
          </div>

          <div class="space-y-3">
            <Segmented
              value={seg()}
              onChange={setSeg}
              options={SEGMENT_DEMO}
              ariaLabel="Demo section"
            />

            <Tabs
              value={tab()}
              onChange={setTab}
              items={TAB_DEMO}
              ariaLabel="Code language"
            />
            <TabPanel value="curl" active={tab()}>
              <div class="p-3 rounded-control bg-surface-muted border border-line-subtle font-mono text-xs text-fg-secondary">
                curl https://gateway.example.com/v1/chat/completions -H "Authorization: Bearer $KEY"
              </div>
            </TabPanel>
            <TabPanel value="ts" active={tab()}>
              <div class="p-3 rounded-control bg-surface-muted border border-line-subtle font-mono text-xs text-fg-secondary">
                const res = await openai.chat.completions.create(&#123; model: "gpt-5" &#125;);
              </div>
            </TabPanel>
            <TabPanel value="py" active={tab()}>
              <div class="p-3 rounded-control bg-surface-muted border border-line-subtle font-mono text-xs text-fg-secondary">
                response = client.chat.completions.create(model="claude-sonnet-4-5")
              </div>
            </TabPanel>
          </div>

          <div class="pt-2 border-t border-line">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-fg-secondary">Spring height collapse</span>
              <Btn size="xs" variant="outline" onClick={() => setCollapseOpen((o) => !o)}>
                {collapseOpen() ? "Collapse section" : "Expand section"}
              </Btn>
            </div>
            <Collapse open={collapseOpen()}>
              <div class="mt-2 p-3 rounded-control bg-surface-muted border border-line-subtle text-xs text-fg-secondary">
                Measured natural height animates smoothly via WAAPI <code class="font-mono">spring.smooth</code> and cleans up inline styles on settle.
              </div>
            </Collapse>
          </div>
        </Card>

        {/* Form Controls */}
        <Card class="p-5 space-y-4">
          <div>
            <h2 class="text-base font-medium text-fg">Form controls & selection</h2>
            <p class="text-xs text-fg-secondary mt-0.5">
              Accessible combobox select, switches, checkboxes and fields with keyboard focus rings.
            </p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Gateway key prefix"
              value={inputVal()}
              onInput={setInputVal}
              hint="Used for audit identification"
            />
            <Select
              label="Default routing model"
              value={selectedModel()}
              onChange={setSelectedModel}
              options={MODEL_OPTIONS}
              searchable
            />
          </div>

          <Textarea
            label="Routing note"
            rows={2}
            value={notesVal()}
            onInput={setNotesVal}
            placeholder="Describe fallback behavior…"
          />

          <SwitchCard
            label="Automatic failover"
            description="Advance to the next healthy target before first byte."
            checked={switchOn()}
            onChange={setSwitchOn}
          />

          <div class="flex flex-wrap items-center gap-6 pt-1">
            <Switch checked={switchOn()} onChange={setSwitchOn} label="Enable sticky lane" />
            <Checkbox checked={checkOn()} onChange={setCheckOn} label="Include cached tokens" />
          </div>
        </Card>
      </div>

      {/* Date, Time & Range Pickers */}
      <Card class="p-5 space-y-4">
        <div>
          <h2 class="text-base font-medium text-fg">Calendars, date & time pickers</h2>
          <p class="text-xs text-fg-secondary mt-0.5">
            Gliding selection discs, distance-aware number color flips, stretching week-by-week range bars, continuous sliding month strips, and rolling date labels.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
          <DatePicker
            label="Scheduled cutover date"
            value={pickedDate()}
            onChange={setPickedDate}
            showToday
          />
          <TimePicker
            label="Cutover window (UTC)"
            value={pickedTime()}
            onChange={setPickedTime}
            minuteStep={15}
          />
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-3 border-t border-line">
          <div class="p-4 rounded-panel border border-line bg-surface-subtle flex flex-col items-center">
            <div class="w-full text-xs font-medium text-fg-secondary mb-2">Single-date Calendar (gliding disc + Today)</div>
            <Calendar value={pickedDate()} onChange={setPickedDate} showToday />
          </div>
          <div class="p-4 rounded-panel border border-line bg-surface-subtle flex flex-col items-center">
            <div class="w-full text-xs font-medium text-fg-secondary mb-2">Range Calendar (stretching week bars + gliding thumbs)</div>
            <div class="w-full max-w-[328px]">
              <RangeCalendar
                from={rangeFrom()}
                to={rangeTo()}
                setFrom={setRangeFrom}
                setTo={setRangeTo}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Overlays, Alerts, Badges & Skeleton */}
      <Card class="p-5 space-y-4">
        <div>
          <h2 class="text-base font-medium text-fg">Overlays, alerts & feedback</h2>
          <p class="text-xs text-fg-secondary mt-0.5">
            Portaled modals, drawers, gliding menus, swipeable toasts and semantic status badges.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <Btn variant="outline" onClick={() => setModalOpen(true)}>
            Open dialog
          </Btn>
          <Btn variant="outline" onClick={() => setDrawerOpen(true)}>
            Open drawer
          </Btn>
          <button
            ref={setMenuAnchor}
            type="button"
            class="ui-button ui-button-outline ui-button-md"
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            onClick={() => setMenuOpen((o) => !o)}
          >
            Open gliding menu
            <Icon name={Icons.chevronDown} size={14} />
          </button>
          <Menu
            open={menuOpen()}
            onClose={() => setMenuOpen(false)}
            anchor={menuAnchor}
            label="Demo actions"
          >
            <MenuLabel>Target actions</MenuLabel>
            <MenuItem icon={Icons.copy} index={0} shortcut="⌘C" onSelect={() => toast("Copied target ID")}>
              Copy target ID
            </MenuItem>
            <MenuItem icon={Icons.refresh} index={1} shortcut="⌘R" onSelect={() => toast.success("Synced models")}>
              Sync upstream models
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Icons.trash} index={2} danger onSelect={() => toast.error("Target removed")}>
              Remove target
            </MenuItem>
          </Menu>

          <Btn variant="subtle" onClick={() => toast("Background sync queued")}>
            Info toast
          </Btn>
          <Btn variant="subtle" onClick={() => toast.success("Provider key verified")}>
            Success toast
          </Btn>
          <Btn variant="subtle" onClick={() => toast.error("Upstream rate limit reached")}>
            Error toast
          </Btn>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-2">
          <Badge tone="neutral">Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="success">Active</Badge>
          <Badge tone="warning">Rate limited</Badge>
          <Badge tone="danger">Degraded</Badge>
          <Badge tone="violet">Router</Badge>
          <Badge tone="blue">OpenAI</Badge>
          <span class="ml-2 inline-flex items-center gap-1 text-xs text-fg-secondary">
            Command palette <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
          </span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
          <Alert tone="accent" title="Sticky routing active" icon={<Icon name={Icons.sparkles} size={16} />}>
            Healthy targets remain pinned per routing lane in memory.
          </Alert>
          <Alert tone="warning" title="Budget threshold near" icon={<Icon name={Icons.warning} size={16} />}>
            85% of the proportional weekly allowance has been settled.
          </Alert>
          <Alert tone="danger" title="Upstream timeout" icon={<Icon name={Icons.alertCircle} size={16} />}>
            Target <code class="font-mono">us-east-1</code> did not respond before first byte.
          </Alert>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div class="p-4 rounded-control border border-line-subtle bg-surface-muted space-y-2.5">
            <div class="text-xs font-medium text-fg-secondary">Skeleton placeholders</div>
            <Skeleton class="h-4 w-2/5" />
            <Skeleton class="h-3 w-4/5" />
            <Skeleton class="h-8 w-full" />
          </div>
          <EmptyState
            icon={Icons.layers}
            title="No custom routes configured"
            description="Add a model target to begin routing requests across upstream providers."
          />
        </div>
      </Card>

      <Modal open={modalOpen()} onClose={() => setModalOpen(false)} title="Dialog spring preview">
        <div class="space-y-4">
          <p class="text-sm text-fg-secondary">
            This dialog enters on <code class="font-mono text-xs">spring.smooth</code>, traps focus inside the layer, and marks the background shell inert.
          </p>
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              onClick={() => {
                setModalOpen(false);
                toast.success("Confirmed dialog action");
              }}
            >
              Confirm
            </Btn>
          </div>
        </div>
      </Modal>

      <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)} label="Drawer preview" side="right">
        <div class="p-5 space-y-4">
          <div class="flex items-center justify-between border-b border-line pb-3">
            <h3 class="text-base font-medium text-fg">Slide-over sheet</h3>
            <IconBtn icon={Icons.x} label="Close drawer" onClick={() => setDrawerOpen(false)} />
          </div>
          <p class="text-sm text-fg-secondary">
            Drawers slide along the viewport edge with touch drag-to-dismiss and shared scroll locking.
          </p>
          <Btn variant="outline" class="w-full" onClick={() => setDrawerOpen(false)}>
            Close sheet
          </Btn>
        </div>
      </Drawer>
    </div>
  );
}
