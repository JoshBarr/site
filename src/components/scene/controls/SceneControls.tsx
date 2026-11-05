import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  available,
  CATEGORIES,
  Category,
  follow,
  followVehicle,
  getSnapshot,
  next,
  setCut,
  stop,
  subscribe,
} from "../follow/store";
import { sceneNow, useSeek } from "../clock";
import { currentView, goTo, SHOTS } from "../shots/shots";
import { jump } from "../time/jump";
import { TimeTravel } from "../time/TimeTravel";
import { useVisibleHeight } from "../useVisibleHeight";
import {
  Credit,
  LicenceLink,
  LIVE_CREDITS,
  MAP_CREDITS,
  Sources,
} from "../credits";
import { Icon, IconName } from "./icons";
import styles from "./SceneControls.module.css";

// The scene's controls, bottom right: a button each for places, following
// transport and settings, opening its panel in one popover that moves and
// resizes from one to the next, and one for the time-travel drawer, which
// they ride up on; and, while replaying or following, a pill saying when or
// what, with the way back. Bottom left, Info: where the data's from.

type PanelId = "places" | "transport" | "settings";

const panels = Popover.createHandle<PanelId>();

// Each in the colour of its trails, by `data-tint` in the stylesheet.
const VEHICLES: Record<
  Category,
  { name: string; icon: IconName; still: string }
> = {
  bus: { name: "Buses", icon: "bus", still: "stopped" },
  train: { name: "Trains", icon: "train", still: "stopped" },
  ship: { name: "Ships", icon: "ship", still: "stopped" },
  plane: { name: "Aircraft", icon: "plane", still: "on the ground" },
};

/** How often the lists of what can be followed are looked at again, ms. */
const LIST_REFRESH = 1000;

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

/** What of each kind can be followed now, looked at again every so often. */
function useAvailable() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), LIST_REFRESH);

    return () => clearInterval(id);
  }, []);

  return available;
}

/**
 * Two steps: a kind of vehicle, then one of them, by name or at random.
 * Or click one on the map; Next moves on to another of the same kind.
 */
const TransportPanel: React.FC = () => {
  const { following } = useFollow();
  const list = useAvailable();

  const [category, setCategory] = useState<Category | null>(
    following?.category ?? null
  );

  const now = following && (
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
  );

  if (!category) {
    return (
      <div className={styles.Panel}>
        <Header title="Follow" hint="or click one on the map" />
        {CATEGORIES.map((kind) => {
          const { name, icon } = VEHICLES[kind];
          const count = list(kind).length;

          return (
            <button
              key={kind}
              type="button"
              className={cx(styles.Row, styles.Button, styles.Vehicle)}
              data-tint={kind}
              disabled={!count}
              aria-pressed={following?.category === kind}
              onClick={() => setCategory(kind)}
            >
              <Icon name={icon} />
              <span className={styles.RowLabel}>{name}</span>
              <span className={styles.Value}>{count}</span>
              <span className={styles.Onward}>
                <Icon name="chevron" size={18} />
              </span>
            </button>
          );
        })}
        {now}
      </div>
    );
  }

  const { name, icon, still } = VEHICLES[category];
  const vehicles = list(category);

  return (
    <div className={styles.Panel} data-tint={category}>
      <div className={styles.Header}>
        <button
          type="button"
          className={styles.Back}
          aria-label="All kinds of transport"
          onClick={() => setCategory(null)}
        >
          <Icon name="back" size={20} />
        </button>
        <span className={styles.Tinted}>
          <Icon name={icon} size={18} />
        </span>
        <Popover.Title className={cx(styles.Title, styles.Grow)}>
          {name}
        </Popover.Title>
        <p className={styles.Hint}>{vehicles.length}</p>
      </div>
      <button
        type="button"
        className={cx(styles.Row, styles.Button, styles.Vehicle)}
        disabled={!vehicles.length}
        onClick={() => follow(category)}
      >
        <Icon name="shuffle" size={18} />
        <span className={styles.RowLabel}>
          {following?.category === category ? "Another" : "Any"}, at random
        </span>
      </button>
      <ul className={styles.Choices} aria-label={name}>
        {vehicles.map(({ id, label, moving, detail }) => (
          <li key={id}>
            <button
              type="button"
              className={cx(styles.Row, styles.Button, styles.Choice)}
              aria-pressed={
                following?.category === category && following.id === id
              }
              onClick={() => followVehicle({ category, id, label })}
            >
              <span className={styles.RowLabel}>{label}</span>
              <span className={styles.Detail}>
                {detail ?? (moving ? "" : still)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {now}
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

const CreditList: React.FC<{ title: string; credits: Credit[] }> = ({
  title,
  credits,
}) => (
  <>
    <h3 className={styles.Section}>{title}</h3>
    {credits.map((credit) => (
      <p key={credit.what} className={styles.Credit}>
        <span className={styles.CreditWhat}>{credit.what}</span> from{" "}
        <Sources credit={credit} linkClass={styles.Link} />
        {credit.licence && (
          <>
            , <LicenceLink licence={credit.licence} linkClass={styles.Link} />
          </>
        )}
        .
      </p>
    ))}
  </>
);

/** Where the scene's data comes from, with the attribution each asks for. */
const Info: React.FC = () => (
  <Popover.Root>
    <div className={cx(styles.Glass, styles.Toolbar)}>
      <Tip
        label="About the data"
        trigger={
          <Popover.Trigger
            aria-label="About the data"
            className={styles.ToolButton}
          >
            <Icon name="info" />
          </Popover.Trigger>
        }
      />
    </div>
    <Popover.Portal>
      <Popover.Positioner
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className={styles.Theme}
      >
        <Popover.Popup className={cx(styles.Glass, styles.Popup)}>
          <div className={cx(styles.Panel, styles.InfoPanel)}>
            <Header title="Data" hint="" />
            <CreditList title="Map" credits={MAP_CREDITS} />
            <CreditList title="Live" credits={LIVE_CREDITS} />
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
);

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
}> = ({ clouds, onCloudsChange }) => {
  const { following } = useFollow();
  const [shot, setShot] = useState<string | null>(null);
  const [travelling, setTravelling] = useState(false);
  const height = useVisibleHeight();

  return (
    <Tooltip.Provider delay={500}>
      <div className={styles.Frame} style={{ height }}>
        <TimeTravel open={travelling}>
          <div className={cx(styles.Theme, styles.Bar)}>
            <Info />
            <div className={styles.End}>
              <Replaying />
              {following && (
                <div
                  className={`${styles.Glass} ${styles.Following}`}
                  data-tint={following.category}
                >
                  <span className={styles.Tinted}>
                    <Icon name={VEHICLES[following.category].icon} size={18} />
                  </span>
                  <span className={styles.FollowingLabel}>
                    {following.label}
                  </span>
                  <Tip
                    label={
                      <>
                        Back to moving freely
                        <span className={styles.Kbd}>Esc</span>
                      </>
                    }
                    trigger={
                      <button
                        type="button"
                        aria-label="Stop following"
                        className={cx(styles.ToolButton, styles.Labelled)}
                        onClick={stop}
                      >
                        <Icon name="close" size={18} />
                        <span className={styles.Wide}>Stop following</span>
                        <span className={styles.Narrow}>Stop</span>
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
                <PanelButton
                  panel="settings"
                  label="Settings"
                  icon="settings"
                />
                <Tip
                  label="Time travel"
                  trigger={
                    <button
                      type="button"
                      aria-label="Time travel"
                      aria-expanded={travelling}
                      className={styles.ToolButton}
                      onClick={() => setTravelling((open) => !open)}
                    >
                      <Icon name={travelling ? "close" : "history"} />
                    </button>
                  }
                />
              </div>
            </div>
          </div>
        </TimeTravel>
      </div>
      <Popover.Root handle={panels}>
        {({ payload }) => (
          <Popover.Portal>
            <Popover.Positioner
              side="top"
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
