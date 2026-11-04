import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  CATEGORIES,
  Category,
  follow,
  getSnapshot,
  next,
  setCut,
  stop,
  subscribe,
} from "../follow/store";
import { sceneNow, useSeek } from "../clock";
import { currentView, goTo, SHOTS } from "../shots/shots";
import { jump } from "../time/jump";
import { Icon, IconName } from "./icons";
import styles from "./SceneControls.module.css";

// The scene's controls, top right: a button each for places, following
// transport and settings, opening its panel in one popover that moves and
// resizes from one to the next; and, while replaying or following, a pill
// saying when or what, with the way back.

type PanelId = "places" | "transport" | "settings";

const panels = Popover.createHandle<PanelId>();

// Each in the colour of its trails, by `data-tint` in the stylesheet.
const VEHICLES: Record<Category, { name: string; icon: IconName }> = {
  bus: { name: "Buses", icon: "bus" },
  train: { name: "Trains", icon: "train" },
  ship: { name: "Ships", icon: "ship" },
  plane: { name: "Aircraft", icon: "plane" },
};

const cx = (...names: string[]) => names.join(" ");

const GROUPS = [...new Set(SHOTS.map(({ group }) => group))];
const SHOT_ITEMS = SHOTS.map(({ id, name }) => ({ value: id, label: name }));

const useFollow = () =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

const Tip: React.FC<{
  label: React.ReactNode;
  trigger: React.ReactElement;
}> = ({ label, trigger }) => (
  <Tooltip.Root>
    <Tooltip.Trigger render={trigger} />
    <Tooltip.Portal>
      <Tooltip.Positioner sideOffset={8} className={styles.Theme}>
        <Tooltip.Popup className={styles.TooltipPopup}>{label}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
);

const PanelButton: React.FC<{
  panel: PanelId;
  label: string;
  icon: IconName;
}> = ({ panel, label, icon }) => (
  <Tip
    label={label}
    trigger={
      <Popover.Trigger
        handle={panels}
        payload={panel}
        aria-label={label}
        className={styles.ToolButton}
      >
        <Icon name={icon} />
      </Popover.Trigger>
    }
  />
);

const Header: React.FC<{ title: string; hint?: string }> = ({
  title,
  hint,
}) => (
  <div className={styles.Header}>
    <Popover.Title className={styles.Title}>{title}</Popover.Title>
    {hint && <p className={styles.Hint}>{hint}</p>}
  </div>
);

/** Set views: pick one and the camera goes there; copy a link to this one. */
const PlacesPanel: React.FC<{
  shot: string | null;
  onShot: (id: string) => void;
}> = ({ shot, onShot }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const view = currentView();

    if (!view) return;
    const url = new URL(location.href);
    url.searchParams.delete("shot");
    url.searchParams.set("cam", view.map(Math.round).join(","));
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={styles.Panel}>
      <Header title="Places" />
      <Select.Root
        items={SHOT_ITEMS}
        value={shot}
        // Picking the one already chosen goes there again.
        onValueChange={(id) => {
          const picked = SHOTS.find((s) => s.id === id);

          if (!picked) return;
          onShot(picked.id);
          goTo(picked);
        }}
      >
        <Select.Trigger
          className={cx(styles.Row, styles.Button, styles.Trigger)}
          aria-label="Go to a place"
        >
          <span className={styles.RowLabel} style={{ flex: "none" }}>
            Go to
          </span>
          <Select.Value className={styles.Value} placeholder="Choose…" />
          <Select.Icon className={styles.Chevron}>
            <Icon name="chevron" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            className={`${styles.Theme} ${styles.SelectPositioner}`}
            alignItemWithTrigger={false}
            sideOffset={4}
          >
            <Select.Popup className={styles.SelectPopup}>
              <Select.List>
                {GROUPS.map((group) => (
                  <Select.Group key={group}>
                    <Select.GroupLabel className={styles.GroupLabel}>
                      {group}
                    </Select.GroupLabel>
                    {SHOTS.filter((s) => s.group === group).map(
                      ({ id, name }) => (
                        <Select.Item
                          key={id}
                          value={id}
                          className={styles.Item}
                        >
                          <Select.ItemText className={styles.ItemText}>
                            {name}
                          </Select.ItemText>
                          <Select.ItemIndicator className={styles.ItemCheck}>
                            <Icon name="check" size={16} />
                          </Select.ItemIndicator>
                        </Select.Item>
                      )
                    )}
                  </Select.Group>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <button
        type="button"
        className={cx(styles.Row, styles.Button, styles.Centered)}
        onClick={copy}
      >
        <Icon name={copied ? "check" : "link"} size={18} />
        {copied ? "Copied" : "Copy link to this view"}
      </button>
    </div>
  );
};

/**
 * Pick a kind of vehicle and the camera follows one of them, or click one
 * on the map; picking the same kind again, or Next, moves on to another.
 */
const TransportPanel: React.FC = () => {
  const { following, counts } = useFollow();

  return (
    <div className={styles.Panel}>
      <Header title="Follow" hint="or click one on the map" />
      {CATEGORIES.map((category) => {
        const { name, icon } = VEHICLES[category];

        return (
          <button
            key={category}
            type="button"
            className={cx(styles.Row, styles.Button, styles.Vehicle)}
            data-tint={category}
            disabled={!counts[category]}
            aria-pressed={following?.category === category}
            onClick={() => follow(category)}
          >
            <Icon name={icon} />
            <span className={styles.RowLabel}>{name}</span>
            <span className={styles.Value}>{counts[category]}</span>
          </button>
        );
      })}
      {following && (
        <div className={styles.Now}>
          <div className={styles.NowText}>
            <span>Following</span>
            <span>{following.label}</span>
          </div>
          <button
            type="button"
            className={cx(styles.Row, styles.Button, styles.Small)}
            onClick={next}
          >
            <Icon name="next" size={18} />
            Next
          </button>
        </div>
      )}
    </div>
  );
};

const SettingsPanel: React.FC<{
  clouds: boolean;
  onCloudsChange: (clouds: boolean) => void;
}> = ({ clouds, onCloudsChange }) => {
  const { cut } = useFollow();

  return (
    <div className={styles.Panel}>
      <Header title="Settings" />
      <label className={cx(styles.Row, styles.Button, styles.SwitchRow)}>
        <Icon name="cloud" size={18} />
        <span className={styles.RowLabel}>Clouds and rain</span>
        <Switch.Root
          className={styles.Switch}
          checked={clouds}
          onCheckedChange={onCloudsChange}
        >
          <Switch.Thumb className={styles.Thumb} />
        </Switch.Root>
      </label>
      <div className={styles.Row}>
        <span className={styles.RowLabel} id="camera-moves">
          Camera moves
        </span>
        <ToggleGroup
          aria-labelledby="camera-moves"
          className={styles.Segments}
          value={[cut ? "cut" : "fly"]}
          // Pressing the pressed one empties the group: keep it as it is.
          onValueChange={([value]) => value && setCut(value === "cut")}
        >
          <Toggle value="fly" className={styles.Segment}>
            Fly
          </Toggle>
          <Toggle value="cut" className={styles.Segment}>
            Cut
          </Toggle>
        </ToggleGroup>
      </div>
    </div>
  );
};

const replayed = new Intl.DateTimeFormat("en-NZ", {
  timeZone: "Pacific/Auckland",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** While the scene's at another time: when, and Back to live. */
const Replaying: React.FC = () => {
  const { replaying } = useSeek();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!replaying) return;
    const tick = () => setNow(sceneNow());

    tick();
    const id = setInterval(tick, 1000);

    return () => clearInterval(id);
  }, [replaying]);

  if (!replaying || now === null) return null;

  return (
    <div className={cx(styles.Glass, styles.Following)}>
      <span className={styles.Muted}>
        <Icon name="history" size={18} />
      </span>
      <span className={styles.Time}>{replayed.format(now)}</span>
      <button
        type="button"
        className={cx(styles.ToolButton, styles.Labelled)}
        onClick={() => jump(null)}
      >
        <span className={styles.LiveDot} />
        <span className={styles.Wide}>Back to live</span>
        <span className={styles.Narrow}>Live</span>
      </button>
    </div>
  );
};

export const SceneControls: React.FC<{
  clouds: boolean;
  onCloudsChange: (clouds: boolean) => void;
  /** On the bar, to place it: under a page's header, say. */
  className?: string;
}> = ({ clouds, onCloudsChange, className = "" }) => {
  const { following } = useFollow();
  const [shot, setShot] = useState<string | null>(null);

  return (
    <Tooltip.Provider delay={500}>
      <div className={cx(styles.Theme, styles.Bar, className)}>
        <Replaying />
        {following && (
          <div
            className={`${styles.Glass} ${styles.Following}`}
            data-tint={following.category}
          >
            <span className={styles.Tinted}>
              <Icon name={VEHICLES[following.category].icon} size={18} />
            </span>
            <span className={styles.FollowingLabel}>{following.label}</span>
            <Tip
              label={
                <>
                  Back to moving freely<span className={styles.Kbd}>Esc</span>
                </>
              }
              trigger={
                <button
                  type="button"
                  className={cx(styles.ToolButton, styles.Labelled)}
                  onClick={stop}
                >
                  <Icon name="close" size={18} />
                  Stop following
                </button>
              }
            />
          </div>
        )}
        <div
          role="toolbar"
          aria-label="Map"
          className={`${styles.Glass} ${styles.Toolbar}`}
        >
          <PanelButton panel="places" label="Places" icon="place" />
          <PanelButton
            panel="transport"
            label="Follow transport"
            icon="commute"
          />
          <PanelButton panel="settings" label="Settings" icon="settings" />
        </div>
      </div>
      <Popover.Root handle={panels}>
        {({ payload }) => (
          <Popover.Portal>
            <Popover.Positioner
              side="bottom"
              align="end"
              sideOffset={8}
              collisionPadding={16}
              className={`${styles.Theme} ${styles.Positioner}`}
            >
              <Popover.Popup className={`${styles.Glass} ${styles.Popup}`}>
                <Popover.Viewport className={styles.Viewport}>
                  {payload === "places" && (
                    <PlacesPanel shot={shot} onShot={setShot} />
                  )}
                  {payload === "transport" && <TransportPanel />}
                  {payload === "settings" && (
                    <SettingsPanel
                      clouds={clouds}
                      onCloudsChange={onCloudsChange}
                    />
                  )}
                </Popover.Viewport>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </Tooltip.Provider>
  );
};
