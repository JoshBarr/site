import { useState, useEffect } from "react";
import { MetserviceForecast } from "../lib/types/metservice";
import { humanTemp, kelvinToCelcius } from "../lib/weather";

const formatter = new Intl.DateTimeFormat(["en-AU"], {
  timeZone: "Pacific/Auckland",
  dateStyle: "medium",
  timeStyle: "short",
  hour12: true,
});

const getDate = (date: Date) => {
  return formatter.format(new Date(date));
};

export const Forecast: React.FC<{ forecast: MetserviceForecast }> = ({
  forecast,
}) => {
  const [isMounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!isMounted) {
    return null;
  }

  const airTemp = humanTemp(
    kelvinToCelcius(forecast.variables["air.temperature.at-2m"].data.at(0))
  );

  const earliestTime = getDate(forecast.dimensions.time.data.at(0));

  return (
    <div className="theme-text">
      The temperature in Wellington was {airTemp}ºC at {earliestTime}
    </div>
  );
};
