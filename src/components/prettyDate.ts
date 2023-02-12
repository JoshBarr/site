const options: Intl.DateTimeFormatOptions = {
  hour12: true,
  timeZone: "Pacific/Auckland",
  day: "numeric",
  month: "short",
  year: "numeric",
};

const formatter = new Intl.DateTimeFormat(["en-US"], options);

export const prettyDate = ({ date }: { date: Date | string }) => {
  if (typeof date === "string") {
    return formatter.format(new Date(date));
  }

  return formatter.format(date);
};
