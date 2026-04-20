export default function ValidationTable({ title, rows, columns }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
        <h3 className="text-sm font-semibold mb-3" style={{ color: '#0129ac' }}>{title}</h3>
        <p className="text-sm" style={{ color: '#4a65c0' }}>No data available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
      <div className="px-6 py-4" style={{ borderBottom: '1px solid #eef1fb' }}>
        <h3 className="text-sm font-semibold" style={{ color: '#0129ac' }}>{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ backgroundColor: '#eef1fb' }}>
              {columns.map((col) => (
                <th key={col.key} className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#4a65c0' }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-t" style={{ borderColor: '#eef1fb' }}>
                {columns.map((col) => (
                  <td key={col.key} className="px-6 py-3 whitespace-nowrap" style={{ color: '#2a40a8' }}>
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
