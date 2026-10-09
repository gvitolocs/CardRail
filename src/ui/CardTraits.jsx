export function CardTraits({ item }) {
  const language = item.language.toLowerCase();
  return (
    <div className="card-traits">
      <span className="trait">
        {["en", "it", "jp", "zh"].includes(language) && (
          <img src={`/brand/flags/${language}.svg`} alt="" />
        )}
        {item.language}
      </span>
      <span className="trait">
        {item.condition !== "M" && (
          <img
            src={`/brand/conditions/${item.condition.toLowerCase()}.svg`}
            alt=""
          />
        )}
        {item.condition}
      </span>
      <span className="trait">{item.printing}</span>
      {item.firstEdition && <span className="trait">1st Ed.</span>}
      {item.signed && <span className="trait">Signed</span>}
      {item.altered && <span className="trait">Altered</span>}
    </div>
  );
}
