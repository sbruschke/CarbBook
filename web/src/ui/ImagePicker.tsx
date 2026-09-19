import { useState } from 'react';
import { useServices } from '../app/services';
import { adoptImage, searchImages, uploadPhoto } from '../lib/images';
import type { ImageCandidate, ImageSearchResult } from '../lib/wire';
import { ImageThumb } from './ImageThumb';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Picks one image for a food or meal (images spec 2026-09-18). It only ever reports the chosen
 * image id: the caller saves it on the record through the ordinary sync push, so the edit queues
 * offline and resolves by last-write-wins like any other field.
 */
export function ImagePicker(props: {
  imageId: string | null | undefined;
  /** Prefills the search box — usually the food or meal name. */
  defaultQuery: string;
  /** Attribution stored with the current image, shown verbatim when there is one. */
  attribution?: string | null;
  onChange: (imageId: string | null) => void;
}) {
  const { api } = useServices();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(props.defaultQuery);
  const [result, setResult] = useState<ImageSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every failure leaves the panel open: the user should be able to pick something else without
  // starting over.
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const search = () =>
    run(async () => {
      setResult(await searchImages(api, query.trim()));
    });

  const pick = (candidate: ImageCandidate) =>
    run(async () => {
      const image = await adoptImage(api, candidate);
      props.onChange(image.id);
      setOpen(false);
      setResult(null);
    });

  const upload = (file: File) =>
    run(async () => {
      const image = await uploadPhoto(api, file);
      props.onChange(image.id);
      setOpen(false);
      setResult(null);
    });

  return (
    <div className="image-picker">
      {props.imageId && (
        <div className="image-current">
          <ImageThumb imageId={props.imageId} alt="Current image" size={120} />
          {props.attribution && <p className="fineprint">{props.attribution}</p>}
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => setOpen(true)}>
              Change
            </button>
            {/* Removing only clears the reference; the stored image row is shared and left alone. */}
            <button type="button" disabled={busy} onClick={() => props.onChange(null)}>
              Remove
            </button>
          </div>
        </div>
      )}
      {!props.imageId && !open && (
        <button type="button" onClick={() => setOpen(true)}>
          Find image
        </button>
      )}
      {open && (
        <div className="image-search">
          <label>
            Search for an image
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" className="primary" disabled={busy || query.trim() === ''} onClick={search}>
              Search
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <label>
            Use my own photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          {result && result.candidates.length === 0 && <p className="muted">No images found.</p>}
          {result && result.candidates.length > 0 && (
            <ul className="image-grid" aria-label="Image results">
              {result.candidates.map((candidate) => (
                <li key={`${candidate.provider}:${candidate.full_url}`}>
                  <button type="button" disabled={busy} onClick={() => void pick(candidate)}>
                    <img src={candidate.thumb_url} alt={candidate.title ?? `Image from ${candidate.provider}`} loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {result?.providers_failed.map((provider) => (
            <p key={provider} className="muted">
              No response from {provider}.
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
