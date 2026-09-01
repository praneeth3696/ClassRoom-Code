/**
 * Renders a database result set as a real table.
 *
 * A query result is tabular, so showing it as one is easier to scan than the
 * monospaced text used for program stdout, and it makes the difference between
 * an expected and an actual row obvious at a glance.
 */
export default function ResultTable({ table, emptyLabel = 'No rows' }) {
  if (!table || !table.columns?.length) {
    return <p className="small muted" style={{ margin: 0 }}>{emptyLabel}</p>;
  }
  const { columns, rows } = table;

  const cell = (value) => {
    if (value === null || value === undefined) return <span className="faint">NULL</span>;
    if (typeof value === 'object') return <span className="mono">{JSON.stringify(value)}</span>;
    return String(value);
  };

  return (
    <div className="table-wrap">
      <table className="result-table">
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="muted">{emptyLabel}</td></tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => <td key={c}>{cell(row[c])}</td>)}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {rows.length > 0 && (
        <div className="small faint" style={{ marginTop: 5 }}>
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
