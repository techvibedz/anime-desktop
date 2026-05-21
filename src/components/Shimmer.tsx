export function Shimmer({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`shimmer rounded ${className}`} style={style} />;
}
