export default function ValidationTable({ title, rows, columns }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="card">
        <div className="card-body" style={{ padding: '16px 24px' }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#0129ac', marginBottom: 6 }}>{title}</p>
          <p style={{ fontSize: 14, color: '#4a65c0' }}>No data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <div className="card-title">{title}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx}>
                {columns.map((col) => (
                  <td key={col.key} style={{ color: '#2a40a8' }}>
                    {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
