import usePersistedState from '../hooks/usePersistedState';
import ProductTabs from '../components/ProductTabs';
import CleanUp from './CleanUp';
import ContentCleanUp from './ContentCleanUp';
import CleanSpace from './CleanSpace';

/**
 * Unified Clean Up — Mail / Content / Message cleanup under one tabbed page
 * (mirrors the Run Agent product tabs). Each product renders its own cleaner,
 * embedded (their standalone page headers are hidden here).
 */
export default function CleanUpHub() {
  const [product, setProduct] = usePersistedState('cleanup:product', 'mail');

  const subtitle = {
    mail: 'Wipe test mailboxes (Gmail / Outlook) before a migration run.',
    content: 'Wipe test files & folders (Box / SharePoint) before a migration run.',
    message: 'Wipe test channels, DMs & messages (Slack / Teams / Google Chat).',
  }[product];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Clean Up</h1>
        <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
      </div>

      <ProductTabs value={product} onChange={setProduct} includeAll={false} />

      {product === 'mail' && <CleanUp embedded />}
      {product === 'content' && <ContentCleanUp embedded />}
      {product === 'message' && <CleanSpace embedded />}
    </div>
  );
}
