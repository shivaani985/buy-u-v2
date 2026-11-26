"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, MapPin, MessageCircle, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { writeFreePostAction } from "@/app/free-items/actions";
import { startConversationAction } from "@/app/messages/actions";
import { submitReportAction } from "@/app/marketplace-actions";
import { ListingImage } from "@/components/shared/ListingImage";
import { useOrderClock } from "@/components/orders/useOrderClock";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { formatMytDateTime } from "@/lib/financials/policy";
import { REPORT_REASONS } from "@/lib/marketplace/phase8";
import {
  FREE_PHOTO_BYTES, FREE_PHOTO_LIMIT, FREE_PHOTO_TYPES, freeNoticePhotoHref,
  getNoticeboardStatus, matchesNoticeboardSearch,
} from "@/lib/marketplace/free-noticeboard";
import type { FreeNoticePost } from "@/lib/marketplace/free-noticeboard-data";

const actionClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border-crisp bg-white px-3 text-sm font-bold text-ink-primary transition-colors hover:border-brand-purple hover:text-brand-purple focus-visible:outline-brand-purple disabled:opacity-50 motion-reduce:transition-none";
const primaryClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-purple px-4 text-sm font-bold text-white transition-colors hover:bg-brand-purple-dark focus-visible:outline-brand-purple disabled:opacity-50 motion-reduce:transition-none";
const fieldClass = "mt-1 w-full rounded-xl border border-border-crisp bg-white px-3 py-2 text-sm font-normal focus-visible:outline-brand-purple";
const dialogClass = "fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border border-border-crisp bg-white p-5 text-ink-primary backdrop:bg-black/45 sm:p-6";
const emptyForm = { title: "", description: "", pickupLocation: "" };

type Photo = { path: string; url: string; local?: boolean };
type Confirm = { post: FreeNoticePost; action: "remove" | "renew" | "report" };

function relativeTime(ms: number, round: "ceil" | "floor") {
  const hours = Math[round](Math.max(0, ms) / 3_600_000);
  if (hours === 0) return "less than an hour";
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  const dayText = days ? `${days} ${days === 1 ? "day" : "days"}` : "";
  const hourText = remainder ? `${remainder} ${remainder === 1 ? "hour" : "hours"}` : "";
  return [dayText, hourText].filter(Boolean).join(" ");
}

export function FreeItemsClient({ posts, identity, donorEligible, userId, serverNow, focusedId }: {
  posts: FreeNoticePost[]; identity: { name: string; matric: string };
  donorEligible: boolean; userId: string; serverNow: number; focusedId?: string;
}) {
  const router = useRouter();
  const now = useOrderClock(serverNow, 1000);
  const [tab, setTab] = useState<"browse" | "mine">("browse");
  const [search, setSearch] = useState("");
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [editing, setEditing] = useState<FreeNoticePost | null>(null);
  const [publishId, setPublishId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [gallery, setGallery] = useState<{ post: FreeNoticePost; index: number } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [reportDetails, setReportDetails] = useState("");
  const composer = useRef<HTMLDialogElement>(null);
  const viewer = useRef<HTMLDialogElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);

  const canPublish = donorEligible && Boolean(identity.name && identity.matric);
  const visibleState = posts.map((post) => removedIds.includes(post.id) ? { ...post, status: "closed" } : post);
  const owned = visibleState.filter((post) => post.contributorId === userId)
    .sort((a, b) => Date.parse(b.renewedAt ?? b.publishedAt) - Date.parse(a.renewedAt ?? a.publishedAt));
  const catalogue = visibleState.filter((post) => post.pickupLocation && getNoticeboardStatus(post, now) === "Active")
    .sort((a, b) => Date.parse(b.renewedAt ?? b.publishedAt) - Date.parse(a.renewedAt ?? a.publishedAt));
  const visible = (tab === "mine" ? owned : catalogue).filter((post) => matchesNoticeboardSearch(post, search));
  const focused = focusedId ? catalogue.find((post) => post.id === focusedId) : undefined;

  const viewedPost = gallery ? visibleState.find((post) => post.id === gallery.post.id) : undefined;
  const canViewGallery = Boolean(viewedPost && (viewedPost.contributorId === userId || catalogue.includes(viewedPost)));
  useEffect(() => {
    if (!canViewGallery) viewer.current?.close();
  }, [canViewGallery]);

  function startComposer(post: FreeNoticePost | null) {
    setError("");
    setEditing(post);
    setForm(post ? { title: post.title, description: post.description, pickupLocation: post.pickupLocation ?? "" } : emptyForm);
    setPublishId(post?.id ?? crypto.randomUUID());
    setPhotos(post?.imagePaths.map((path, index) => ({ path, url: freeNoticePhotoHref(post.id, index) })) ?? []);
    composer.current?.showModal();
  }

  function clearPhotos(deleteUploads: boolean) {
    const local = photos.filter((photo) => photo.local);
    for (const photo of local) URL.revokeObjectURL(photo.url);
    if (deleteUploads && local.length) {
      void getSupabaseBrowserClient()?.storage.from("free-items").remove(local.map((photo) => photo.path));
    }
    setPhotos([]);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setError("");
    if (files.length + photos.length > FREE_PHOTO_LIMIT) {
      setError("Add up to 5 photos.");
      return;
    }
    if (files.some((file) => !Object.hasOwn(FREE_PHOTO_TYPES, file.type) || file.size <= 0 || file.size > FREE_PHOTO_BYTES)) {
      setError("Use JPG, PNG or WebP photos up to 5 MB each.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setError("Photo upload is unavailable."); return; }

    try {
      for (const [index, file] of files.entries()) {
        setUploading(`Uploading photo ${index + 1} of ${files.length}…`);
        const extension = FREE_PHOTO_TYPES[file.type as keyof typeof FREE_PHOTO_TYPES];
        const path = `${userId}/${crypto.randomUUID()}.${extension}`;
        const result = await supabase.storage.from("free-items").upload(path, file, { contentType: file.type, upsert: false });
        if (result.error) {
          setError(`Could not upload ${file.name}. Try adding that photo again.`);
          break;
        }
        const url = URL.createObjectURL(file);
        setPhotos((previous) => [...previous, { path, url, local: true }]);
      }
    } catch {
      setError("Photo upload failed. Please try again.");
    } finally {
      setUploading("");
    }
  }

  function removePhoto(photo: Photo) {
    setPhotos((previous) => previous.filter((entry) => entry.path !== photo.path));
    if (photo.local) {
      URL.revokeObjectURL(photo.url);
      void getSupabaseBrowserClient()?.storage.from("free-items").remove([photo.path]);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || uploading || !canPublish || !photos.length) return;
    setPending(true);
    setError("");
    try {
      const result = await writeFreePostAction({
        id: publishId, action: editing ? "edit" : "publish",
        post: { ...form, imagePaths: photos.map((photo) => photo.path) },
      });
      if (!result.ok) { setError(result.message); return; }
      clearPhotos(false);
      composer.current?.close();
      setNotice(result.message);
      router.refresh();
    } catch {
      setError("The post could not be saved. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function chat(post: FreeNoticePost) {
    if (chatId) return;
    setChatId(post.id);
    setNotice("");
    try {
      const result = await startConversationAction({ sellerId: post.contributorId, freeNoticeId: post.id });
      if (result.ok && result.href) router.push(result.href);
      else setNotice(result.error ?? "Could not open the conversation.");
    } catch {
      setNotice("Could not open the conversation. Try again.");
    } finally {
      setChatId(null);
    }
  }

  function openConfirm(post: FreeNoticePost, action: Confirm["action"]) {
    setError("");
    setAcknowledged(false);
    setReportDetails("");
    setReason(REPORT_REASONS[0]);
    setConfirm({ post, action });
    confirmation.current?.showModal();
  }

  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirm || pending || (confirm.action === "renew" && !acknowledged)) return;
    setError("");
    setPending(true);
    try {
      const result = confirm.action === "report"
        ? await submitReportAction({ targetKind: "free_notice", targetId: confirm.post.id, reason, explanation: reportDetails })
        : await writeFreePostAction({ id: confirm.post.id, action: confirm.action, acknowledged });
      if (!result.ok) { setError(result.message); return; }
      if (confirm.action === "remove") setRemovedIds((ids) => [...ids, confirm.post.id]);
      setNotice(result.message);
      confirmation.current?.close();
      router.refresh();
    } catch {
      setError("Could not complete this action. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">Free Items</h1>
          <p className="mt-1 text-sm text-ink-secondary">Give what you don’t need. Take what you can use.</p>
        </div>
        {donorEligible && (canPublish
          ? <button className={primaryClass} type="button" onClick={() => startComposer(null)}><Plus size={18} aria-hidden="true" />Post Free Item</button>
          : <Link className={primaryClass} href="/account#student-profile">Complete Profile to Post</Link>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border-crisp py-2">
        <div className="flex gap-2" aria-label="Free Items views" role="group">
          <button type="button" aria-pressed={tab === "browse"} onClick={() => setTab("browse")} className={tab === "browse" ? primaryClass : actionClass}>Browse Free Items</button>
          {donorEligible && <button type="button" aria-pressed={tab === "mine"} onClick={() => setTab("mine")} className={tab === "mine" ? primaryClass : actionClass}>My Posts</button>}
        </div>
        <label className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-border-crisp px-3 sm:w-auto">
          <Search size={17} aria-hidden="true" className="shrink-0 text-brand-purple" />
          <span className="sr-only">Search free items</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="Search items or location" className="min-w-0 flex-1 py-2 text-sm focus-visible:outline-brand-purple" />
        </label>
      </div>
      {tab === "browse" && <p className="rounded-xl bg-brand-teal/10 px-4 py-3 text-sm text-ink-primary">Free items are available on a first-come, first-served basis. You can collect directly from the stated location or contact the donor for more information. Physical availability is not guaranteed.</p>}
      {focusedId && !focused && <p role="status" className="text-sm text-ink-secondary">This free item post is unavailable.</p>}
      {notice && <p role="status" className="rounded-lg bg-surface-paper px-4 py-2 text-sm">{notice}</p>}
      {visible.length === 0 ? <div className="rounded-xl border border-border-crisp bg-white p-8 text-center">
        <p className="font-bold">{search ? "No posts match your search" : tab === "mine" ? "You haven’t posted any free items yet" : "No free items are listed right now"}</p>
        {search ? <button className={`${actionClass} mt-3`} type="button" onClick={() => setSearch("")}>Clear Search</button>
          : tab === "mine" && canPublish && <button className={`${actionClass} mt-3`} type="button" onClick={() => startComposer(null)}>Post Free Item</button>}
      </div> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((post) => {
            const own = post.contributorId === userId;
            const status = getNoticeboardStatus(post, now);
            const published = Date.parse(post.renewedAt ?? post.publishedAt);
            const remaining = Date.parse(post.expiresAt) - now;
            return <article id={`post-${post.id}`} key={post.id} className={`flex min-w-0 scroll-mt-24 flex-col overflow-hidden rounded-xl border bg-white ${post.id === focused?.id ? "border-brand-purple" : "border-border-crisp"}`}>
              <button type="button" onClick={() => { setGallery({ post, index: 0 }); viewer.current?.showModal(); }}
                className="relative block aspect-[4/3] w-full bg-surface-paper focus-visible:outline-brand-purple" aria-label={`View photos and details for ${post.title}`}>
                <ListingImage key={post.imagePaths[0]} src={post.imagePaths.length ? freeNoticePhotoHref(post.id, 0) : null} alt={post.title}
                  fallback={<span className="grid h-full place-items-center text-ink-secondary"><Camera aria-hidden="true" /></span>} />
                <span className="absolute left-3 top-3 rounded-full bg-white px-2.5 py-1 text-xs font-extrabold text-brand-purple">FREE</span>
                {post.imagePaths.length > 1 && <span className="absolute bottom-3 right-3 rounded-full bg-white px-2.5 py-1 text-xs font-bold">{post.imagePaths.length} photos</span>}
              </button>
              <div className="flex flex-1 flex-col gap-3 p-4">
                <div>
                  <h2 className="break-words text-lg font-extrabold leading-tight">{post.title}</h2>
                  <p className="mt-1 text-xs text-ink-secondary">Donor · {post.donor}</p>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-surface-paper p-3 text-sm">
                  <MapPin size={17} className="mt-0.5 shrink-0 text-brand-purple" aria-hidden="true" />
                  <div className="min-w-0"><p className="font-bold">Pickup Location</p>
                    <p className="whitespace-pre-wrap break-words">{post.pickupLocation ?? "Add an exact pickup location before this post can be discovered."}</p>
                  </div>
                </div>
                {post.description && <p className="line-clamp-3 break-words text-sm text-ink-secondary">{post.description}</p>}
                <p className="mt-auto text-xs text-ink-secondary">
                  {own && tab === "mine" && <strong>{status} · </strong>}
                  Posted {relativeTime(now - published, "floor")} ago
                  {status === "Active" ? ` · Expires in ${relativeTime(remaining, "ceil")}`
                    : status === "Expired" ? ` · Expired ${formatMytDateTime(post.expiresAt)}` : ""}
                </p>
                {own && tab === "mine" && status === "Active" && <p className="text-xs text-ink-secondary">Published {formatMytDateTime(post.renewedAt ?? post.publishedAt)} · Expires {formatMytDateTime(post.expiresAt)}</p>}
                <div className="flex flex-wrap gap-2 border-t border-border-crisp pt-3">
                  {own ? (status === "Active" || status === "Expired") && <>
                    {canPublish && <button type="button" className={actionClass} onClick={() => startComposer(post)}>Edit Post</button>}
                    {canPublish && status === "Expired" && post.pickupLocation && <button type="button" className={primaryClass} onClick={() => openConfirm(post, "renew")}>Renew Post</button>}
                    <button type="button" className={actionClass} onClick={() => openConfirm(post, "remove")}>Remove Post</button>
                  </> : <>
                    <button type="button" className={actionClass} disabled={Boolean(chatId)} onClick={() => chat(post)}>
                      <MessageCircle size={16} aria-hidden="true" />{chatId === post.id ? "Opening Chat…" : "Chat with Donor"}
                    </button>
                    <button type="button" className={actionClass} onClick={() => openConfirm(post, "report")}>Report</button>
                  </>}
                </div>
              </div>
            </article>;
          })}
        </div>
      )}

      <dialog ref={composer} className={dialogClass} aria-labelledby="free-compose-title"
        onCancel={(event) => { if (pending || uploading) event.preventDefault(); else clearPhotos(true); }}>
        <form onSubmit={save} className="space-y-4">
          <h2 id="free-compose-title" className="font-display text-2xl font-bold">{editing ? "Edit Post" : "Post Free Item"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-bold">Donor Name<input className={fieldClass} required readOnly value={identity.name} /></label>
            <label className="text-sm font-bold">Matric Number<input className={fieldClass} required readOnly value={identity.matric} /></label>
          </div>
          <label className="block text-sm font-bold">Item Name
            <input className={fieldClass} required minLength={5} maxLength={100} placeholder="e.g. Free textbooks and stationery"
              value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>
          <label className="block text-sm font-bold">Pickup Location
            <textarea className={fieldClass} required minLength={5} maxLength={500} rows={2} aria-describedby="free-pickup-help"
              value={form.pickupLocation} onChange={(event) => setForm({ ...form, pickupLocation: event.target.value })} />
          </label>
          <p id="free-pickup-help" className="text-xs text-ink-secondary">Enter the exact location where you have placed the items so other campus members can find them. Use an accessible campus location and keep private room addresses out of the post.</p>
          <label className="block text-sm font-bold">Description <span className="font-normal">(optional)</span>
            <textarea className={fieldClass} maxLength={2000} rows={3} value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </label>
          <div>
            <label className="block text-sm font-bold">Item Photos
              <input className={fieldClass} type="file" accept="image/jpeg,image/png,image/webp" multiple
                onChange={upload} disabled={Boolean(uploading) || pending || photos.length >= FREE_PHOTO_LIMIT} />
            </label>
            <p className="mt-1 text-xs text-ink-secondary">1–5 JPG, PNG or WebP photos, up to 5 MB each.</p>
            {uploading && <p role="status" className="mt-1 text-sm">{uploading}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {photos.map((photo, index) => <div key={photo.path} className="relative size-20 overflow-hidden rounded-lg border border-border-crisp">
                <ListingImage src={photo.url} alt={`Photo ${index + 1}`} fallback={null} />
                <button type="button" disabled={pending || Boolean(uploading)} onClick={() => removePhoto(photo)}
                  aria-label={`Remove photo ${index + 1}`} className="absolute right-0 top-0 grid size-9 place-items-center rounded-bl-lg bg-white text-ink-primary">
                  <X size={17} aria-hidden="true" />
                </button>
              </div>)}
            </div>
          </div>
          {!editing && <p className="text-sm text-ink-secondary">Your post will be visible for 3 days. You can remove it earlier if the items are no longer available or renew it after expiration if the items are still available.</p>}
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button className={actionClass} type="button" disabled={pending || Boolean(uploading)}
              onClick={() => { clearPhotos(true); composer.current?.close(); }}>Cancel</button>
            <button className={primaryClass} type="submit" disabled={pending || Boolean(uploading) || !photos.length}>
              {pending ? "Saving…" : editing ? "Save Changes" : "Publish Free Item"}
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={viewer} className={dialogClass} aria-labelledby="free-gallery-title">
        {gallery && canViewGallery && <>
          <div className="mb-3 flex justify-between gap-3">
            <h2 id="free-gallery-title" className="font-display text-2xl font-bold">{gallery.post.title}</h2>
            <button className={actionClass} type="button" onClick={() => viewer.current?.close()} aria-label="Close photos"><X size={18} aria-hidden="true" /></button>
          </div>
          <div className="mx-auto aspect-[4/3] max-h-[45dvh] overflow-hidden rounded-xl bg-surface-paper">
            <ListingImage key={gallery.post.imagePaths[gallery.index]} src={freeNoticePhotoHref(gallery.post.id, gallery.index)} alt={gallery.post.title} fallback={null} />
          </div>
          {gallery.post.imagePaths.length > 1 && <div className="mt-2 flex flex-wrap gap-2">
            {gallery.post.imagePaths.map((path, index) => <button type="button" key={path} className={actionClass}
              aria-pressed={gallery.index === index} onClick={() => setGallery({ ...gallery, index })}>Photo {index + 1}</button>)}
          </div>}
          {gallery.post.description && <p className="mt-4 whitespace-pre-wrap break-words text-sm">{gallery.post.description}</p>}
        </>}
      </dialog>

      <dialog ref={confirmation} className={dialogClass} aria-labelledby="free-confirm-title"
        onCancel={(event) => { if (pending) event.preventDefault(); }}>
        {confirm && <form onSubmit={confirmAction} className="space-y-4">
          <h2 id="free-confirm-title" className="font-display text-2xl font-bold">{confirm.action === "renew" ? "Renew this free item post?" : confirm.action === "remove" ? "Remove this post?" : "Report Free Item"}</h2>
          {confirm.action === "renew" && <>
            <p className="text-sm">Only renew this post if the items are still available at the stated pickup location.</p>
            <label className="flex items-start gap-2 text-sm font-semibold"><input type="checkbox" checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5 size-5 accent-brand-purple" />
              I confirm that these items are still available for collection.
            </label>
          </>}
          {confirm.action === "remove" && <p className="text-sm">It will no longer appear in the Free Items catalogue.</p>}
          {confirm.action === "report" && <>
            <label className="block text-sm font-bold">Reason<select className={fieldClass} value={reason}
              onChange={(event) => setReason(event.target.value)}>{REPORT_REASONS.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="block text-sm font-bold">Details<textarea className={fieldClass} value={reportDetails}
              onChange={(event) => setReportDetails(event.target.value)} required minLength={10} maxLength={1500} rows={3} /></label>
          </>}
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button className={actionClass} type="button" disabled={pending} onClick={() => confirmation.current?.close()}>Cancel</button>
            <button className={primaryClass} type="submit" disabled={pending || (confirm.action === "renew" && !acknowledged)}>
              {pending ? "Saving…" : confirm.action === "renew" ? "Renew for 3 Days" : confirm.action === "remove" ? "Remove Post" : "Send Report"}
            </button>
          </div>
        </form>}
      </dialog>
    </div>
  );
}
