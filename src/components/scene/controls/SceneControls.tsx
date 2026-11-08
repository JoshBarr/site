import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
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
import { goTo, SHOTS } from "../shots/shots";
import { jump } from "../time/jump";
import { toggleMapView, useMapView } from "../mapView";
import { TimeTravel } from "../time/TimeTravel";
import { useVisibleHeight } from "../useVisibleHeight";
import { FOCUS_SHIFT_MAX, getFocusShift, setFocusShift } from "../lens";
import {
  Credit,
  LicenceLink,
  LIVE_CREDITS,
  MAP_CREDITS,
  Sources,
} from "../credits";
import { Icon, IconName } from "./icons";
import styles from "./SceneControls.module.css";

// The scene's controls, bottom right: the map view, clouds and wind switches; a
// button each for places, following transport, the camera and Info (where the
// data's from), opening its panel in one popover that moves and resizes from
// one to the next; and last, one for the time-travel drawer, which they ride up
// on. While replaying or following, a pill saying when or what, with the way
// back.

type PanelId = "places" | "transport" | "camera" | "info";

const panels = Popover.createHandle<PanelId>();

/** The panels' gap above the toolbar, and from the screen's edge, px. */
const GAP = 8;
const EDGE = 16;

// Each in the colour of its trails, by `data-tint` in the stylesheet.
const VEHICLES: Record<
  Category,
  { name: string; icon: IconName; still: string }
> = {
  bus: { name: "Buses", icon: "bus", still: "stopped" },
  train: { name: "Trains", icon: "train", still: "stopped" },
  ship: { name: "Ships", icon: "ship", still: "stopped" },
  plane: { name: "Aircraft", icon: "plane", still: "on the ground" },
  satellite: { name: "Satellites", icon: "satellite", still: "in shadow" },
};

/** How often the lists of what can be followed are looked at again, ms. */
const LIST_REFRESH = 1000;

const cx = (...names: string[]) => names.join(" ");

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

const Header: React.FC<{ title: string }> = ({ title }) => (
  <div className={styles.Header}>
    <Popover.Title className={styles.Title}>{title}</Popover.Title>
  </div>
);

/** Set views: pick one and the camera goes there. */
const PlacesPanel: React.FC<{
  shot: string | null;
  onShot: (id: string) => void;
}> = ({ shot, onShot }) => (
  <div className={styles.Panel}>
    <Header title="Places" />
    <ul className={styles.Choices} aria-label="Places">
      {SHOTS.map((picked) => (
        <li key={picked.id}>
          <button
            type="button"
            className={cx(styles.Row, styles.Button, styles.Choice)}
            aria-pressed={shot === picked.id}
            // Picking the one already chosen goes there again.
            onClick={() => {
              onShot(picked.id);
              goTo(picked);
            }}
          >
            <span className={styles.RowLabel}>{picked.name}</span>
          </button>
        </li>
      ))}
    </ul>
  </div>
);

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
 * Two steps: a kind of vehicle, then one of them, by name or a lucky dip.
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
        <Header title="Follow" />
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
        <span className={styles.RowLabel}>Lucky dip</span>
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
                {[detail, moving ? null : still].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {now}
    </div>
  );
};

/** Focus's distance, as a multiple of where autofocus puts it. */
const focusText = (stops: number) =>
  stops === 0 ? "Auto" : `×${(2 ** stops).toPrecision(2)}`;

/** How the camera moves to a place, and where it focuses. */
const CameraPanel: React.FC = () => {
  const { cut } = useFollow();
  const [shift, setShift] = useState(getFocusShift);

  return (
    <div className={styles.Panel}>
      <Header title="Camera" />
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
      <Slider.Root
        className={cx(styles.Row, styles.SliderRow)}
        value={shift}
        min={-FOCUS_SHIFT_MAX}
        max={FOCUS_SHIFT_MAX}
        step={0.1}
        onValueChange={(stops) => {
          setShift(stops);
          setFocusShift(stops);
        }}
      >
        <div className={styles.SliderHead}>
          <Slider.Label className={styles.RowLabel}>Focus</Slider.Label>
          <Slider.Value className={styles.Value}>
            {(_, [stops]) => focusText(stops)}
          </Slider.Value>
        </div>
        <Slider.Control className={styles.SliderControl}>
          <Slider.Track className={styles.Track}>
            <Slider.Thumb
              className={styles.Thumb}
              getAriaValueText={(_, stops) =>
                stops === 0
                  ? "Autofocus"
                  : `${(2 ** stops).toPrecision(2)} times as far as autofocus`
              }
            />
          </Slider.Track>
        </Slider.Control>
        <div className={styles.SliderEnds} aria-hidden>
          <span>Nearer</span>
          <span>Farther</span>
        </div>
      </Slider.Root>
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
const InfoPanel: React.FC = () => (
  <div className={cx(styles.Panel, styles.InfoPanel)}>
    <Header title="Data" />
    <CreditList title="Map" credits={MAP_CREDITS} />
    <CreditList title="Live" credits={LIVE_CREDITS} />
  </div>
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
  wind: boolean;
  onWindChange: (wind: boolean) => void;
}> = ({ clouds, onCloudsChange, wind, onWindChange }) => {
  const { following } = useFollow();
  const map = useMapView();
  const [shot, setShot] = useState<string | null>(null);
  const [travelling, setTravelling] = useState(false);
  const height = useVisibleHeight();
  const toolbar = useRef<HTMLDivElement>(null);
  // The room above the toolbar, measured as a panel opens, for the panels'
  // lists to fit in. Not Base UI's --available-height: while it measures the
  // popup to size the positioner, that's `max-content`, which no calc() takes,
  // so a list capped by it is measured at full length and the too-tall
  // positioner is pushed up the screen, away from the toolbar.
  const [room, setRoom] = useState<number | null>(null);

  return (
    <Tooltip.Provider delay={500}>
      <div className={styles.Frame} style={{ height }}>
        <TimeTravel open={travelling}>
          <div className={cx(styles.Theme, styles.Bar)}>
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
              ref={toolbar}
              role="toolbar"
              aria-label="Map"
              className={`${styles.Glass} ${styles.Toolbar}`}
            >
              <Tip
                label={
                  <>
                    {map ? "Leave map view" : "Map view"}
                    <span className={styles.Kbd}>M</span>
                  </>
                }
                trigger={
                  <button
                    type="button"
                    aria-label="Map view"
                    aria-pressed={map}
                    className={styles.ToolButton}
                    onClick={toggleMapView}
                  >
                    <Icon name="map" />
                  </button>
                }
              />
              <Tip
                label={clouds ? "Hide clouds and rain" : "Show clouds and rain"}
                trigger={
                  <button
                    type="button"
                    aria-label="Clouds and rain"
                    aria-pressed={clouds}
                    // On is the usual way: its icon says so, not a highlight.
                    data-quiet
                    className={styles.ToolButton}
                    onClick={() => onCloudsChange(!clouds)}
                  >
                    <Icon name={clouds ? "cloud" : "cloudOff"} />
                  </button>
                }
              />
              <Tip
                label={wind ? "Hide the wind" : "Show the wind"}
                trigger={
                  <button
                    type="button"
                    aria-label="Wind"
                    aria-pressed={wind}
                    className={styles.ToolButton}
                    onClick={() => onWindChange(!wind)}
                  >
                    <Icon name="air" />
                  </button>
                }
              />
              <PanelButton panel="places" label="Places" icon="place" />
              <PanelButton
                panel="transport"
                label="Follow transport"
                icon="commute"
              />
              <PanelButton panel="camera" label="Camera" icon="camera" />
              <PanelButton panel="info" label="About the data" icon="info" />
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
        </TimeTravel>
      </div>
      <Popover.Root
        handle={panels}
        onOpenChange={(open) => {
          const top = toolbar.current?.getBoundingClientRect().top;

          if (open && top !== undefined) setRoom(top - GAP - EDGE);
        }}
      >
        {({ payload }) => (
          <Popover.Portal>
            <Popover.Positioner
              side="top"
              align="end"
              sideOffset={GAP}
              collisionPadding={EDGE}
              className={`${styles.Theme} ${styles.Positioner}`}
              // SAFETY: React's style type lists no custom properties, but
              // passes "--" names through to the element as they are.
              style={
                room === null
                  ? undefined
                  : ({ "--room": `${room}px` } as React.CSSProperties)
              }
            >
              <Popover.Popup className={`${styles.Glass} ${styles.Popup}`}>
                <Popover.Viewport className={styles.Viewport}>
                  {payload === "places" && (
                    <PlacesPanel shot={shot} onShot={setShot} />
                  )}
                  {payload === "transport" && <TransportPanel />}
                  {payload === "camera" && <CameraPanel />}
                  {payload === "info" && <InfoPanel />}
                </Popover.Viewport>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </Tooltip.Provider>
  );
};
