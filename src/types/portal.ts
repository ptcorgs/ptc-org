export type UserRole = 'student' | 'president' | 'cessca';

export type PostStatus = 'pending' | 'approved' | 'rejected';

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  orgCode: string | null;
}

export interface OrganizationProfile {
  bannerDataUrl: string | null;
  avatarDataUrl: string | null;
  aboutText: string;
  organizationName: string;
  organizationShortName: string;
  presidentName: string;
  facebookUrl: string | null;
}

export interface OrgPost {
  id: string;
  letterRef: string;
  orgCode: string;
  orgShortName: string;
  orgFullName: string;
  authorName: string;
  title: string;
  eventDate: string;
  caption: string;
  imageUrl: string | null;
  imageUrls?: string[];
  status: PostStatus;
  feedback: string | null;
  likesCount: number;
  likedByViewer?: boolean;
  createdAt: string;
  reviewedAt: string | null;
}

export interface SubmissionQueueItem {
  id: string;
  letterRef: string;
  orgCode: string;
  orgShortName: string;
  orgFullName: string;
  presidentName: string;
  title: string;
  eventDate: string;
  caption: string;
  imageUrl: string | null;
  status: PostStatus;
  feedback: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface ProposalSubmission {
  id: string;
  orgCode: string;
  orgShortName: string;
  orgFullName: string;
  presidentName: string;
  title: string;
  message: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  submittedAt: string;
  status: PostStatus;
  feedback: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface OrgStats {
  orgCode: string;
  approvedCount: number;
  pendingCount: number;
  latestPostAt: string | null;
  avatarUrl: string | null;
}
