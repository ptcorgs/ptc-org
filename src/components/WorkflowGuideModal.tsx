import React from 'react';
import { X, Users, FileCheck2, ShieldCheck } from 'lucide-react';

interface WorkflowGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WorkflowGuideModal({ isOpen, onClose }: WorkflowGuideModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-guide-title"
    >
      <div className="bg-white border border-stone-200 rounded-xl shadow-xl w-full max-w-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <h2 id="workflow-guide-title" className="font-display text-xl font-semibold text-stone-900">
            PTC Organization Portal & CESSCA Approval Flow
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-stone-700 rounded-lg hover:bg-stone-100 transition-colors cursor-pointer"
            aria-label="Close approval guide"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 text-sm text-stone-700">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 border border-stone-200 rounded-xl space-y-2">
              <Users className="w-5 h-5 text-[#166534]" />
              <h3 className="font-semibold text-stone-900">1. Students</h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Read-only access to all 12 official organization pages and the Global Campus Feed.
                No sign-in required.
              </p>
            </div>

            <div className="p-4 border border-stone-200 rounded-xl space-y-2">
              <FileCheck2 className="w-5 h-5 text-[#166534]" />
              <h3 className="font-semibold text-stone-900">2. Org Presidents</h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Sign in via the top-right Login button. Access is scoped strictly to their assigned
                organization to submit pending event letters.
              </p>
            </div>

            <div className="p-4 border border-stone-200 rounded-xl space-y-2">
              <ShieldCheck className="w-5 h-5 text-[#166534]" />
              <h3 className="font-semibold text-stone-900">3. CESSCA Admin</h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Reviews proposal files and letter submissions across all 12 organizations. Organization
                posts publish directly to their own pages.
              </p>
            </div>
          </div>

          <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl text-xs text-stone-600 leading-relaxed">
            <span className="font-semibold text-stone-900">Isolated 1-to-1 Storage: </span>
            Each of the 12 official student organizations stores its event records in its own
            dedicated libSQL database, synchronized with CESSCA&apos;s central moderation queue.
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-white bg-[#166534] hover:bg-[#14532d] rounded-lg transition-colors cursor-pointer"
            >
              Got It
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
