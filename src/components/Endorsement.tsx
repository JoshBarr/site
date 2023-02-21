import styles from "./Endorsement.module.css";

export interface EndorsementType {
  body: string;
  author: {
    name: string;
    role?: string;
  };
}

export const Endorsement = ({
  endorsement,
}: {
  endorsement: EndorsementType;
}) => {
  return (
    <div>
      <blockquote className={`theme-text measure ${styles.endorsement}`}>
        {endorsement.body}
      </blockquote>
      <p className="theme-body-text small">
        <span className="theme-text">{endorsement.author.name} –</span>{" "}
        {endorsement.author.role}
      </p>
    </div>
  );
};
