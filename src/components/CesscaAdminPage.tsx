import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Search,
  ShieldCheck,
  XCircle,
  ExternalLink,
  FileDown,
  FileText,
  Eye,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLiveUpdates } from '../hooks/useLiveUpdates';
import { resolvePostImageUrl } from '../lib/mediaAssets';
import { notifyPortalDataChanged } from '../lib/portalUpdates';
import type { PostStatus, ProposalSubmission, SubmissionQueueItem } from '../types/portal';

interface CesscaAdminPageProps {
  onSelectOrg: (orgCode: string) => void;
  onOpenLogin: () => void;
  onOpenLightbox: (imageUrl: string, caption: string) => void;
}

type QueueFilter = 'all' | PostStatus;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const PREVIEWABLE_PROPOSAL_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function isPreviewableProposal(proposal: ProposalSubmission): boolean {
  return PREVIEWABLE_PROPOSAL_CONTENT_TYPES.has(
    proposal.contentType.split(';', 1)[0].trim().toLowerCase()
  );
}

export function CesscaAdminPage({ onSelectOrg, onOpenLogin, onOpenLightbox }: CesscaAdminPageProps) {
  const { user, getAuthHeaders } = useAuth();
  const [items, setItems] = useState<SubmissionQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<QueueFilter>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedbackInput, setFeedbackInput] = useState('');
  const [processingAction, setProcessingAction] = useState<
    'approve' | 'reject' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalSubmission[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalActionId, setProposalActionId] = useState<string | null>(null);
  const [proposalAction, setProposalAction] = useState<'download' | 'preview' | null>(null);
  const [proposalPreview, setProposalPreview] = useState<{
    url: string;
    fileName: string;
    contentType: string;
  } | null>(null);

  useEffect(() => {
    if (!proposalPreview) return;
    return () => URL.revokeObjectURL(proposalPreview.url);
  }, [proposalPreview]);

  const loadQueue = useCallback(async () => {
    if (user?.role !== 'cessca') {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/cessca/queue', {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        const nextItems = (data.items ?? []) as SubmissionQueueItem[];
        setItems(nextItems);
        setSelectedId((prev) => {
          if (prev && nextItems.some((item) => item.id === prev)) return prev;
          const firstPending = nextItems.find((i) => i.status === 'pending');
          return firstPending?.id ?? nextItems[0]?.id ?? null;
        });
      }
    } finally {
      setLoading(false);
    }
  }, [user?.role, getAuthHeaders]);

  useLiveUpdates(loadQueue);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const loadProposals = useCallback(async () => {
    if (user?.role !== 'cessca') {
      setProposalsLoading(false);
      return;
    }
    try {
      const response = await fetch('/api/cessca/proposals', { headers: getAuthHeaders() });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load proposal files.');
      }
      setProposals((data.proposals ?? []) as ProposalSubmission[]);
      setProposalError(null);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : 'Failed to load proposal files.');
    } finally {
      setProposalsLoading(false);
    }
  }, [user?.role, getAuthHeaders]);

  useLiveUpdates(loadProposals);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  const counts = useMemo(() => {
    return {
      all: items.length,
      pending: items.filter((i) => i.status === 'pending').length,
      approved: items.filter((i) => i.status === 'approved').length,
      rejected: items.filter((i) => i.status === 'rejected').length,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      if (!q) return true;
      return (
        item.orgShortName.toLowerCase().includes(q) ||
        item.presidentName.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.letterRef.toLowerCase().includes(q)
      );
    });
  }, [items, statusFilter, searchQuery]);

  const selectedItem = useMemo(
    () => filteredItems.find((i) => i.id === selectedId) ?? filteredItems[0] ?? null,
    [selectedId, filteredItems]
  );

  useEffect(() => {
    setActionError(null);
    setFeedbackInput(selectedItem?.feedback ?? '');
  }, [selectedItem?.id]);

  async function handleReview(action: 'approve' | 'reject') {
    if (!selectedItem) return;
    setActionError(null);
    if (selectedItem.status !== 'pending') {
      setActionError('Only pending letters can be approved or rejected.');
      return;
    }

    if (action === 'reject' && feedbackInput.trim().length < 4) {
      setActionError('Please enter reviewer feedback explaining why the letter is rejected.');
      return;
    }

    setProcessingAction(action);
    try {
      const res = await fetch(`/api/cessca/review/${selectedItem.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          action,
          feedback: feedbackInput.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update submission status.');
      }
      const updatedItem = data.item as SubmissionQueueItem;
      setItems((current) =>
        current.map((item) => (item.id === updatedItem.id ? updatedItem : item))
      );
      notifyPortalDataChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      setProcessingAction(null);
    }
  }

  async function fetchProposalFile(proposal: ProposalSubmission): Promise<Blob> {
    const response = await fetch(
      `/api/cessca/proposals/${encodeURIComponent(proposal.id)}/file`,
      { headers: getAuthHeaders() }
    );
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Unable to access proposal file.');
    }
    return response.blob();
  }

  async function handleProposalDownload(proposal: ProposalSubmission) {
    setProposalActionId(proposal.id);
    setProposalAction('download');
    setProposalError(null);
    try {
      const file = await fetchProposalFile(proposal);
      const fileUrl = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = fileUrl;
      anchor.download = proposal.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : 'Unable to download proposal file.');
    } finally {
      setProposalActionId(null);
      setProposalAction(null);
    }
  }

  async function handleProposalPreview(proposal: ProposalSubmission) {
    setProposalActionId(proposal.id);
    setProposalAction('preview');
    setProposalError(null);
    try {
      const file = await fetchProposalFile(proposal);
      const contentType = proposal.contentType.split(';', 1)[0].trim().toLowerCase();
      if (!PREVIEWABLE_PROPOSAL_CONTENT_TYPES.has(contentType)) {
        throw new Error('This file type cannot be previewed. Use Download to open it.');
      }
      const previewFile = new Blob([file], { type: contentType });
      setProposalPreview({
        url: URL.createObjectURL(previewFile),
        fileName: proposal.fileName,
        contentType,
      });
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : 'Unable to preview proposal file.');
    } finally {
      setProposalActionId(null);
      setProposalAction(null);
    }
  }


  if (user?.role !== 'cessca') {
    return (
      <main className="portal-page-enter mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-6 text-center">
          <div className="w-12 h-12 rounded-xl bg-[#166534]/10 text-[#166534] flex items-center justify-center mx-auto">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h1 className="font-display text-2xl font-semibold text-stone-900">
            CESSCA Super Administrator Panel
          </h1>
          <p className="text-sm text-stone-600 max-w-md mx-auto">
            This administration console is restricted to CESSCA administrators managing proposal
            files and letter submissions.
          </p>
          <button
            type="button"
            onClick={onOpenLogin}
            className="px-5 py-2.5 text-sm font-medium text-white bg-[#166534] hover:bg-[#14532d] rounded-lg transition-colors cursor-pointer"
          >
            Sign In as CESSCA Admin
          </button>
        </div>
      </main>
    );
  }

  const selectedImgUrl = resolvePostImageUrl(selectedItem?.imageUrl);

  return (
    <main className="portal-page-enter mx-auto max-w-7xl space-y-3 px-3 py-4 sm:space-y-4 sm:px-6 sm:py-6">
      <div className="flex flex-col justify-between gap-2.5 sm:flex-row sm:items-end sm:gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-emerald-100 font-medium">
            Super Administrator Console
          </div>
          <h1 className="mt-1 font-display text-2xl font-semibold text-white sm:text-3xl">
            CESSCA Submissions
          </h1>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search letter ref, org, or title..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#166534]/20 focus:border-[#166534]"
          />
        </div>
      </div>

      {proposalError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {proposalError}
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-stone-200 bg-white">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-stone-900">Proposal Files</h2>
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
            {proposals.length}
          </span>
        </div>
        {proposalsLoading ? (
          <div className="p-6 text-sm text-stone-500">Loading proposal submissions...</div>
        ) : proposals.length === 0 ? (
          <div className="p-6 text-center text-sm text-stone-500">No proposal files submitted.</div>
        ) : (
          <div className="divide-y divide-stone-100">
            {proposals.map((proposal) => (
              <article key={proposal.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-800">
                    {proposal.orgShortName} · {formatDate(proposal.submittedAt)}
                  </div>
                  <h3 className="mt-1 text-sm font-semibold text-stone-900">{proposal.title}</h3>
                  <p className="mt-0.5 text-xs text-stone-600">
                    {proposal.orgFullName} · Submitted by {proposal.presidentName}
                  </p>
                  {proposal.message && (
                    <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-stone-700">
                      {proposal.message}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
                    <FileText className="h-4 w-4 text-emerald-800" />
                    <span className="break-all font-medium text-stone-800">{proposal.fileName}</span>
                    <span>{formatFileSize(proposal.fileSize)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {isPreviewableProposal(proposal) && (
                    <button
                      type="button"
                      disabled={proposalActionId !== null}
                      onClick={() => void handleProposalPreview(proposal)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {proposalActionId === proposal.id && proposalAction === 'preview' ? 'Opening...' : 'Preview'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={proposalActionId !== null}
                    onClick={() => void handleProposalDownload(proposal)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-800 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-900 disabled:opacity-50"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    {proposalActionId === proposal.id && proposalAction === 'download' ? 'Working...' : 'Download'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Summary KPI Strip */}
      <div className="portal-stagger grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-stone-200 bg-white p-2.5 sm:p-3">
          <div className="text-[11px] text-stone-500 sm:text-xs">Pending Review</div>
          <div className="mt-1 font-mono text-xl font-semibold text-amber-700 tabular-nums sm:text-2xl">
            {counts.pending}
          </div>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-2.5 sm:p-3">
          <div className="text-[11px] text-stone-500 sm:text-xs">Approved</div>
          <div className="mt-1 font-mono text-xl font-semibold text-emerald-700 tabular-nums sm:text-2xl">
            {counts.approved}
          </div>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-2.5 sm:p-3">
          <div className="text-[11px] text-stone-500 sm:text-xs">Rejected</div>
          <div className="mt-1 font-mono text-xl font-semibold text-red-700 tabular-nums sm:text-2xl">
            {counts.rejected}
          </div>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-2.5 sm:p-3">
          <div className="text-[11px] text-stone-500 sm:text-xs">Total Letters Logged</div>
          <div className="mt-1 font-mono text-xl font-semibold text-stone-900 tabular-nums sm:text-2xl">
            {counts.all}
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 p-1 bg-stone-200/70 rounded-lg w-fit overflow-x-auto">
        {(
          [
            { key: 'pending', label: `Pending (${counts.pending})` },
            { key: 'approved', label: `Approved (${counts.approved})` },
            { key: 'rejected', label: `Rejected (${counts.rejected})` },
            { key: 'all', label: `All Letters (${counts.all})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setStatusFilter(tab.key)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              statusFilter === tab.key
                ? 'bg-white text-stone-900 shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-white">Letter Submissions</h2>
      </section>

      {/* Letter Table + Split Inspector */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7 bg-white border border-stone-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-8 text-sm text-stone-500">Loading submission queue...</div>
          ) : filteredItems.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <p className="text-sm font-medium text-stone-900">
                No letters in the {statusFilter} queue.
              </p>
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className="text-xs font-medium text-[#166534] hover:underline cursor-pointer"
              >
                View all submissions
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wider text-stone-500">
                    <th className="py-3 px-4 font-semibold">Ref</th>
                    <th className="py-3 px-4 font-semibold">Organization</th>
                    <th className="py-3 px-4 font-semibold">Event Title</th>
                    <th className="py-3 px-4 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-xs">
                  {filteredItems.map((item) => {
                    const isSelected = selectedItem?.id === item.id;
                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-[#166534]/5' : 'hover:bg-stone-50'
                        }`}
                      >
                        <td className="py-3 px-4 font-mono text-stone-600 tabular-nums whitespace-nowrap">
                          {item.letterRef}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-semibold text-stone-900">{item.orgShortName}</div>
                          <div className="text-[11px] text-stone-500">{item.presidentName}</div>
                        </td>
                        <td className="py-3 px-4 max-w-[240px]">
                          <div className="font-medium text-stone-900 truncate">{item.title}</div>
                          <div className="text-[11px] text-stone-500 tabular-nums">
                            Event: {item.eventDate}
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {item.status === 'pending' && (
                            <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                              <Clock className="w-3.5 h-3.5" />
                              Pending
                            </span>
                          )}
                          {item.status === 'approved' && (
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Approved
                            </span>
                          )}
                          {item.status === 'rejected' && (
                            <span className="inline-flex items-center gap-1 font-medium text-red-700">
                              <XCircle className="w-3.5 h-3.5" />
                              Rejected
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: Letter & Media Inspector */}
        <aside className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 lg:col-span-5">
          {!selectedItem ? (
            <div className="py-10 text-center text-sm text-stone-500">
              Select a submission row to inspect its media and letter details.
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 pb-3 border-b border-stone-200">
                <div>
                  <div className="flex items-center gap-2 text-xs text-stone-500">
                    <span className="font-mono tabular-nums">{selectedItem.letterRef}</span>
                    <span aria-hidden="true">·</span>
                    <span>Submitted {formatDate(selectedItem.submittedAt)}</span>
                  </div>
                  <h2 className="font-display text-lg font-semibold text-stone-900 mt-1">
                    {selectedItem.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectOrg(selectedItem.orgCode)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#166534] hover:underline shrink-0 cursor-pointer"
                >
                  <span>{selectedItem.orgShortName} Page</span>
                  <ExternalLink className="w-3 h-3" />
                </button>
              </div>

              <div className="text-xs text-stone-600 space-y-1">
                <div>
                  <span className="text-stone-400">Organization: </span>
                  <span className="font-medium text-stone-900">{selectedItem.orgFullName}</span>
                </div>
                <div>
                  <span className="text-stone-400">Submitted By: </span>
                  <span className="font-medium text-stone-900">
                    President {selectedItem.presidentName}
                  </span>
                </div>
                <div>
                  <span className="text-stone-400">Scheduled Date: </span>
                  <span className="font-medium text-stone-900 tabular-nums">
                    {selectedItem.eventDate}
                  </span>
                </div>
              </div>

              <div className="p-3.5 bg-stone-50 border border-stone-200 rounded-lg text-sm text-stone-800 leading-relaxed whitespace-pre-line">
                {selectedItem.caption}
              </div>

              {selectedImgUrl && (
                <button
                  type="button"
                  onClick={() => onOpenLightbox(selectedImgUrl, selectedItem.title)}
                  className="block w-full border border-stone-200 rounded-lg overflow-hidden cursor-zoom-in"
                >
                  <img
                    src={selectedImgUrl}
                    alt={selectedItem.title}
                    referrerPolicy="no-referrer"
                    className="w-full max-h-56 object-cover"
                  />
                </button>
              )}

              <div className="space-y-2 pt-2 border-t border-stone-200">
                {selectedItem.status === 'pending' ? (
                  <>
                    <label
                      htmlFor="cessca-feedback"
                      className="block text-xs font-medium text-stone-700"
                    >
                      CESSCA Review Remarks (required when rejecting)
                    </label>
                    <textarea
                      id="cessca-feedback"
                      rows={2}
                      value={feedbackInput}
                      onChange={(e) => setFeedbackInput(e.target.value)}
                      placeholder="Optional approval note or mandatory revision reason..."
                      className="w-full px-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#166534]/20 focus:border-[#166534]"
                    />
                  </>
                ) : (
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                      Review Remarks
                    </div>
                    <p className="text-sm leading-relaxed text-stone-800">
                      {selectedItem.feedback || 'No remarks were added.'}
                    </p>
                    {selectedItem.reviewedAt && (
                      <p className="mt-2 text-xs text-stone-500">
                        {selectedItem.status === 'approved' ? 'Approved' : 'Rejected'} on{' '}
                        {formatDateTime(selectedItem.reviewedAt)}
                        {selectedItem.reviewedBy ? ` by ${selectedItem.reviewedBy}` : ''}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {actionError && (
                <div className="p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
                  {actionError}
                </div>
              )}

              <div
                className={`grid gap-3 pt-1 ${
                  selectedItem.status === 'pending' ? 'grid-cols-2' : 'grid-cols-1'
                }`}
              >
                {selectedItem.status === 'pending' && (
                  <>
                    <button
                      type="button"
                      disabled={processingAction !== null}
                      onClick={() => void handleReview('reject')}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-red-800 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>{processingAction === 'reject' ? 'Rejecting...' : 'Reject Letter'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={processingAction !== null}
                      onClick={() => void handleReview('approve')}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>
                        {processingAction === 'approve' ? 'Approving...' : 'Approve'}
                      </span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
      {proposalPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${proposalPreview.fileName}`}
          onClick={() => setProposalPreview(null)}
        >
          <div
            className="flex h-[min(92vh,900px)] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-stone-900">File preview</h2>
                <p className="break-all text-xs text-stone-600">{proposalPreview.fileName}</p>
              </div>
              <button
                type="button"
                onClick={() => setProposalPreview(null)}
                className="shrink-0 rounded-lg border border-stone-300 px-3 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-stone-100 p-2 sm:p-4">
              {proposalPreview.contentType === 'application/pdf' ? (
                <iframe
                  src={proposalPreview.url}
                  title={`Preview of ${proposalPreview.fileName}`}
                  className="h-full w-full rounded border border-stone-300 bg-white"
                />
              ) : (
                <img
                  src={proposalPreview.url}
                  alt={proposalPreview.fileName}
                  className="h-full w-full object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
