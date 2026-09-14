import { useState } from 'react';
import { useSearchIndex } from '../app/hooks';
import type { SearchResult } from '../search/search';
import { formatCarbs } from './format';

const SOURCE_LABELS = { custom: 'My food', off: 'Open Food Facts', usda: 'USDA' } as const;

function describe(result: SearchResult): string {
  if (result.kind === 'meal') return 'Meal';
  const parts = [result.brand, result.source ? SOURCE_LABELS[result.source] : null];
  parts.push(result.carbs_per_100g === null ? 'no carb data' : `${formatCarbs(result.carbs_per_100g)} carbs / 100 g`);
  return parts.filter(Boolean).join(' · ');
}

/** Unified search (spec §8): recents before typing, then ranked local results. */
export function SearchPanel(props: { onPick: (result: SearchResult) => void; onScan?: () => void; label?: string }) {
  const index = useSearchIndex();
  const [query, setQuery] = useState('');
  const typing = query.trim() !== '';
  const results = index ? (typing ? index.search(query, 25) : index.recent(8)) : [];

  return (
    <div className="search">
      <div className="search-bar">
        <input
          type="search"
          aria-label={props.label ?? 'Search foods and meals'}
          placeholder="Meals, foods, USDA…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {props.onScan && (
          <button type="button" onClick={props.onScan}>
            Scan
          </button>
        )}
      </div>
      {!typing && results.length > 0 && <h3>Recent</h3>}
      <ul className="results" aria-label="Search results">
        {results.map((result) => (
          <li key={result.id}>
            <button
              type="button"
              className="result"
              onClick={() => {
                props.onPick(result);
                setQuery('');
              }}
            >
              <span className="result-name">{result.name}</span>
              <span className="result-meta">{describe(result)}</span>
            </button>
          </li>
        ))}
      </ul>
      {typing && index && results.length === 0 && <p className="muted">No matches.</p>}
    </div>
  );
}
