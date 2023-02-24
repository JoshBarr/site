export interface MetserviceForecast {
  dimensions: Dimensions;
  noDataReasons: NoDataReasons;
  variables: Variables;
}

export interface Dimensions {
  point: Point;
  time: Time;
}

export interface Point {
  type: Type;
  units: string;
  data: Datum[];
}

export interface Datum {
  lon: number;
  lat: number;
}

export enum Type {
  Point = "point",
  Time = "time",
}

export interface Time {
  type: Type;
  units: string;
  data: Date[];
}

export interface NoDataReasons {
  ERROR_INTERNAL: number;
  FILL: number;
  GAP: number;
  GOOD: number;
  INVALID_HIGH: number;
  INVALID_LOW: number;
  MASK_ICE: number;
  MASK_LAND: number;
}

export interface Variables {
  "air.temperature.at-2m": UnitVariable;
  "air.visibility": UnitVariable;
  "wave.height": WaveHeight;
  "wind.direction.at-10m": UnitVariable;
  "wind.speed.at-10m": UnitVariable;
  "wind.speed.gust.at-10m": UnitVariable;
}

export interface UnitVariable {
  standardName: string;
  units: string;
  siUnits: string;
  dimensions: Type[];
  data: number[];
  noData: number[];
}

export interface WaveHeight {
  standardName: string;
  units: string;
  siUnits: string;
  dimensions: Type[];
  data: null[];
  noData: number[];
}
