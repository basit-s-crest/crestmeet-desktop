'use client';

import React, { useState, useMemo, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Calendar,
  Clock,
  Search,
  Plus,
  Trash2,
  Pencil,
  ArrowRight,
  ArrowUpDown,
  ChevronDown,
  X,
  Folder,
  FolderPlus,
  FolderKanban,
  Users,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  User,
  NotebookPen,
  ArrowLeft,
  Mic,
  Archive,
  RotateCcw,
  FileText,
  LoaderIcon,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useSidebar, CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { useAuth } from '@/contexts/AuthContext';
import { useProject } from '@/contexts/ProjectContext';
import { ProjectWithRole, ProjectRole } from '@/types/project';
import {
  CreateProjectDialog,
  ProjectMembersDialog,
  ProjectSettingsDialog,
} from '@/components/Project';
import {
  formatMeetingDate,
  formatMeetingTime,
  getRelativeTime,
  cleanMeetingTitle,
} from '@/lib/dateUtils';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ConfirmationModal } from '@/components/ConfirmationModel/confirmation-modal';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type SortOrder = 'newest' | 'oldest';
type DateFilter = 'all' | 'today' | 'week' | 'month' | 'custom';

interface DateFilterOption {
  id: DateFilter;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

const DATE_FILTER_OPTIONS: DateFilterOption[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom', icon: Calendar },
];

// Main overview tabs (constant)
const OVERVIEW_TABS = [
  { id: 'active', label: 'Active Projects', icon: FolderKanban },
  { id: 'archived', label: 'Archived', icon: Archive },
] as const;

export default function MeetingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { meetings, setMeetings, setCurrentMeeting, isLoadingMeetings } = useSidebar();
  const { user } = useAuth();
  const { projects, activeProject, switchProject, archiveProject, deleteProject } = useProject();

  // Selected project for drill-down view (null = viewing projects overview)
  const [selectedProject, setSelectedProject] = useState<ProjectWithRole | null>(null);

  // Overview tab: 'active' | 'archived'
  const [overviewTab, setOverviewTab] = useState<'active' | 'archived'>('active');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });

  // Search & Filter state for inside-project meetings
  const [meetingSearch, setMeetingSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [customDateStart, setCustomDateStart] = useState('');
  const [customDateEnd, setCustomDateEnd] = useState('');

  // Search state for projects overview grid
  const [projectSearch, setProjectSearch] = useState('');

  // Search state for archived projects overview grid
  const [archivedSearch, setArchivedSearch] = useState('');

  // Modals state
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [membersModalProject, setMembersModalProject] = useState<ProjectWithRole | null>(null);
  const [settingsModalProject, setSettingsModalProject] = useState<ProjectWithRole | null>(null);
  const [projectToArchive, setProjectToArchive] = useState<ProjectWithRole | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<ProjectWithRole | null>(null);

  const [deleteModalState, setDeleteModalState] = useState<{
    isOpen: boolean;
    meetingId: string | null;
  }>({
    isOpen: false,
    meetingId: null,
  });

  const [editModalState, setEditModalState] = useState<{
    isOpen: boolean;
    meetingId: string | null;
    currentTitle: string;
  }>({
    isOpen: false,
    meetingId: null,
    currentTitle: '',
  });
  const [editingTitle, setEditingTitle] = useState('');

  // Handle URL query parameter for project deep link if present
  useEffect(() => {
    const projectIdParam = searchParams.get('project');
    if (projectIdParam && projects.length > 0) {
      const found = projects.find((p) => p.id === projectIdParam);
      if (found) {
        setSelectedProject(found);
        switchProject(found.id);
      }
    }
  }, [searchParams, projects, switchProject]);

  // Keep selectedProject in sync when projects change (e.g. archived, restored, or updated)
  useEffect(() => {
    if (selectedProject) {
      const found = projects.find((p) => p.id === selectedProject.id);
      if (found) {
        setSelectedProject(found);
      } else {
        setSelectedProject(null);
      }
    }
  }, [projects]);

  // Keep selectedProject in sync when activeProject changes (e.g. switched from ProjectSwitcher)
  useEffect(() => {
    if (selectedProject && activeProject && selectedProject.id !== activeProject.id) {
      const found = projects.find((p) => p.id === activeProject.id);
      if (found) {
        setSelectedProject(found);
      }
    }
  }, [activeProject, selectedProject, projects]);

  // Update animated tab underline position for overview tabs
  useLayoutEffect(() => {
    if (selectedProject) return;
    const activeIndex = OVERVIEW_TABS.findIndex((tab) => tab.id === overviewTab);
    const activeTabElement = tabRefs.current[activeIndex];

    if (activeTabElement) {
      const { offsetLeft, offsetWidth } = activeTabElement;
      setUnderlineStyle({ left: offsetLeft, width: offsetWidth });
    }
  }, [overviewTab, selectedProject]);

  // Open a specific project's meetings view
  const handleOpenProject = async (project: ProjectWithRole) => {
    setSelectedProject(project);
    setMeetingSearch('');
    await switchProject(project.id);
  };

  // Return to all projects overview
  const handleBackToProjects = () => {
    setSelectedProject(null);
    setMeetingSearch('');
  };

  // Start recording directly for the currently selected project
  const handleRecordForCurrentProject = async () => {
    if (selectedProject && !selectedProject.is_archived) {
      await switchProject(selectedProject.id);
      sessionStorage.setItem('autoStartRecording', 'true');
      router.push('/');
    }
  };

  // Project archive/restore handlers
  const handleArchiveProject = (project: ProjectWithRole) => {
    setProjectToArchive(project);
  };

  const handleRestoreProject = async (project: ProjectWithRole) => {
    await archiveProject(project.id, false);
  };

  const handleDeleteProject = (project: ProjectWithRole) => {
    setProjectToDelete(project);
  };

  // Active vs Archived project lists
  const activeProjects = useMemo(
    () => projects.filter((p) => !p.is_archived),
    [projects]
  );

  const archivedProjects = useMemo(
    () => projects.filter((p) => p.is_archived),
    [projects]
  );

  // Filter projects in the 'Active Projects' overview
  const filteredActiveProjects = useMemo(() => {
    if (!projectSearch.trim()) return activeProjects;
    const query = projectSearch.toLowerCase().trim();
    return activeProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.description && p.description.toLowerCase().includes(query))
    );
  }, [activeProjects, projectSearch]);

  // Filter projects in the 'Archived' overview
  const filteredArchivedProjects = useMemo(() => {
    if (!archivedSearch.trim()) return archivedProjects;
    const query = archivedSearch.toLowerCase().trim();
    return archivedProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.description && p.description.toLowerCase().includes(query))
    );
  }, [archivedProjects, archivedSearch]);

  // Determine if meetings for the selected project are currently loading or switching
  const isProjectMeetingsLoading =
    isLoadingMeetings ||
    (selectedProject ? activeProject?.id !== selectedProject.id : false);

  // Total meetings count for selected project
  const selectedProjectMeetingsCount = useMemo(() => {
    if (!selectedProject) return 0;
    return meetings.filter((m) =>
      !m.project_id ? selectedProject.is_personal : m.project_id === selectedProject.id
    ).length;
  }, [meetings, selectedProject]);

  // Filter and sort meetings for the inside-project view
  const filteredAndSortedMeetings = useMemo(() => {
    if (!selectedProject) return [];

    // Filter to only include meetings belonging to this specific project
    let result = meetings.filter((m) => {
      if (!m.project_id) {
        return selectedProject.is_personal;
      }
      return m.project_id === selectedProject.id;
    });

    // Name search filter
    if (meetingSearch.trim()) {
      const query = meetingSearch.toLowerCase().trim();
      result = result.filter((m) => {
        const titleMatch = m.title.toLowerCase().includes(query);
        const cleanedTitleMatch = cleanMeetingTitle(m.title, m.created_at)
          .toLowerCase()
          .includes(query);
        return titleMatch || cleanedTitleMatch;
      });
    }

    // Date preset filter
    if (dateFilter !== 'all') {
      const now = new Date();
      result = result.filter((m) => {
        if (!m.created_at) return false;
        const meetingDate = new Date(m.created_at);
        if (isNaN(meetingDate.getTime())) return false;

        switch (dateFilter) {
          case 'today':
            return meetingDate.toDateString() === now.toDateString();
          case 'week': {
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - now.getDay());
            startOfWeek.setHours(0, 0, 0, 0);
            return meetingDate >= startOfWeek;
          }
          case 'month': {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
            return meetingDate >= startOfMonth;
          }
          case 'custom': {
            if (customDateStart) {
              const start = new Date(customDateStart);
              start.setHours(0, 0, 0, 0);
              if (meetingDate < start) return false;
            }
            if (customDateEnd) {
              const end = new Date(customDateEnd);
              end.setHours(23, 59, 59, 999);
              if (meetingDate > end) return false;
            }
            return true;
          }
          default:
            return true;
        }
      });
    }

    // Newest / Oldest sort filter
    result.sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return sortOrder === 'newest' ? timeB - timeA : timeA - timeB;
    });

    return result;
  }, [meetings, meetingSearch, dateFilter, customDateStart, customDateEnd, sortOrder]);

  // Meeting deletion
  const handleDeleteConfirm = async () => {
    const meetingId = deleteModalState.meetingId;
    if (!meetingId) return;

    try {
      await invoke('api_delete_meeting', { meetingId });
      setMeetings(meetings.filter((m) => m.id !== meetingId));
      toast.success('Meeting deleted successfully');
    } catch (err: any) {
      console.error('Failed to delete meeting:', err);
      toast.error('Failed to delete meeting', {
        description: err?.toString() || 'Unknown error',
      });
    } finally {
      setDeleteModalState({ isOpen: false, meetingId: null });
    }
  };

  // Meeting title update
  const handleEditConfirm = async () => {
    const meetingId = editModalState.meetingId;
    const newTitle = editingTitle.trim();
    if (!meetingId || !newTitle) {
      toast.error('Title cannot be empty');
      return;
    }

    try {
      await invoke('api_save_meeting_title', {
        meetingId,
        title: newTitle,
      });
      setMeetings(
        meetings.map((m) => (m.id === meetingId ? { ...m, title: newTitle } : m))
      );
      toast.success('Meeting title updated');
      setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
      setEditingTitle('');
    } catch (err: any) {
      console.error('Failed to update title:', err);
      toast.error('Failed to update title', {
        description: err?.toString() || 'Unknown error',
      });
    }
  };

  // Navigate to meeting details
  const navigateToMeeting = (meeting: CurrentMeeting) => {
    setCurrentMeeting(meeting);
    router.push(`/meeting-details?id=${meeting.id}`);
  };

  // Find project name for an archived meeting
  const getProjectName = (projectId?: string) => {
    if (!projectId) return 'Personal Project';
    const found = projects.find((p) => p.id === projectId);
    return found ? found.name : 'Project';
  };

  const renderRoleBadge = (role: ProjectRole) => {
    switch (role) {
      case 'owner':
        return (
          <span className="inline-flex items-center px-3 py-0.5 rounded-full text-xs font-semibold bg-[#FEF3C7] text-[#92400E] border border-[#FDE68A]">
            Owner
          </span>
        );
      case 'team_leader':
        return (
          <span className="inline-flex items-center gap-1 px-3 py-0.5 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200">
            <Star className="w-3 h-3 text-purple-600" />
            Team Leader
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-3 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700 border border-gray-200">
            <User className="w-3 h-3 text-gray-500" />
            Member
          </span>
        );
    }
  };

  return (
    <div className="h-screen bg-gray-50 flex flex-col">
      {/* Sticky Header — Aligned with Settings Page UI */}
      <div className="sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-8 py-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              {selectedProject ? (
                <div>
                  <button
                    onClick={handleBackToProjects}
                    className="flex items-center gap-1.5 text-gray-600 hover:text-gray-900 transition-colors mb-3 text-sm font-medium"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Back to projects</span>
                  </button>
                  <div className="flex items-center gap-3 flex-wrap">
                    <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
                      {selectedProject.name}
                    </h1>
                    {selectedProject.is_archived && (
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                        <Archive className="w-3 h-3 text-amber-600" />
                        Archived
                      </span>
                    )}
                    {renderRoleBadge(selectedProject.role)}
                    <span className="text-xs font-medium text-gray-600 px-2.5 py-1 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center min-w-[50px] min-h-[26px]">
                      {isProjectMeetingsLoading ? (
                        <LoaderIcon className="w-3.5 h-3.5 animate-spin text-gray-400" />
                      ) : (
                        `${selectedProjectMeetingsCount} ${selectedProjectMeetingsCount === 1 ? 'call' : 'calls'}`
                      )}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {selectedProject.description || 'Workspace for meetings, transcripts, and summaries.'}
                  </p>
                </div>
              ) : (
                <div>
                  <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
                  <p className="text-sm text-gray-600 mt-1">
                    Manage your active workspaces and access archived meeting records.
                  </p>
                </div>
              )}
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-3 shrink-0">
              {!selectedProject ? (
                <Button
                  variant="outline"
                  onClick={() => setIsCreateProjectOpen(true)}
                  className="flex items-center gap-2 border-gray-300 text-gray-700 hover:bg-gray-100 rounded-lg shadow-sm"
                >
                  <FolderPlus className="w-4 h-4 text-gray-600" />
                  <span>New Project</span>
                </Button>
              ) : selectedProject.is_archived ? (
                <Button
                  variant="outline"
                  onClick={() => handleRestoreProject(selectedProject)}
                  className="flex items-center gap-2 border-amber-300 text-amber-900 hover:bg-amber-100 bg-white rounded-lg shadow-sm font-medium transition-colors"
                >
                  <RotateCcw className="w-4 h-4 text-amber-700" />
                  <span>Restore Project</span>
                </Button>
              ) : (
                <div className="flex items-center gap-2.5">
                  <Button
                    variant="outline"
                    onClick={() => setMembersModalProject(selectedProject)}
                    className="flex items-center gap-2 border-gray-200 bg-white text-gray-800 hover:bg-gray-50 rounded-xl text-sm font-medium shadow-2xs h-10 px-3.5"
                  >
                    <Users className="w-4 h-4 text-gray-600" />
                    <span>Members {selectedProject.member_count}</span>
                  </Button>

                  {(selectedProject.role === 'owner' || selectedProject.role === 'team_leader') && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setSettingsModalProject(selectedProject)}
                      className="border-gray-200 bg-white text-gray-800 hover:bg-gray-50 rounded-xl shadow-2xs h-10 w-10 shrink-0"
                      title="Project Settings"
                    >
                      <SettingsIcon className="w-4 h-4 text-gray-600" />
                    </Button>
                  )}

                  <Button
                    onClick={handleRecordForCurrentProject}
                    className="flex items-center gap-2 bg-[#DC2626] hover:bg-[#b91c1c] text-white rounded-xl shadow-2xs font-medium text-sm h-10 px-4 transition-colors"
                  >
                    <Mic className="w-4 h-4" />
                    <span>Record call</span>
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Header Tabs Bar — Only shown on Projects Overview (Active Projects / Archived) */}
          {!selectedProject && (
            <div className="mt-6">
              <Tabs
                value={overviewTab}
                onValueChange={(val) => setOverviewTab(val as 'active' | 'archived')}
              >
                <TabsList className="bg-transparent relative rounded-none border-b border-gray-200 p-0 h-auto flex gap-1 justify-start">
                  {OVERVIEW_TABS.map((tab, index) => {
                    const Icon = tab.icon;
                    const count = tab.id === 'active' ? activeProjects.length : archivedProjects.length;
                    return (
                      <TabsTrigger
                        key={tab.id}
                        value={tab.id}
                        ref={(el) => {
                          tabRefs.current[index] = el;
                        }}
                        className="flex items-center gap-2 px-6 py-3.5 bg-transparent rounded-none border-0 data-[state=active]:bg-transparent data-[state=active]:text-blue-600 data-[state=active]:shadow-none text-gray-600 hover:text-gray-900 relative z-10 text-sm font-medium transition-colors cursor-pointer"
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span>{tab.label}</span>
                        <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-gray-100 text-gray-600">
                          {count}
                        </span>
                      </TabsTrigger>
                    );
                  })}

                  <motion.div
                    className="absolute bottom-0 z-20 h-0.5 bg-blue-600"
                    layoutId="underline"
                    style={{ left: underlineStyle.left, width: underlineStyle.width }}
                    transition={{ type: 'spring', stiffness: 400, damping: 40 }}
                  />
                </TabsList>
              </Tabs>
            </div>
          )}
        </div>
      </div>

      {/* Scrollable Body Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-8 pt-6">
          {/* ============================================================== */}
          {/* VIEW 1: PROJECTS OVERVIEW (No specific project selected)        */}
          {/* ============================================================== */}
          {!selectedProject && (
            <>
              {/* TAB 1: ACTIVE PROJECTS */}
              {overviewTab === 'active' && (
                <div className="space-y-6">
                  {/* Search projects bar */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                      <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="Search projects..."
                        value={projectSearch}
                        onChange={(e) => setProjectSearch(e.target.value)}
                        className="w-full pl-10 pr-10 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-gray-900 placeholder:text-gray-400 shadow-sm transition-all"
                      />
                      {projectSearch && (
                        <button
                          onClick={() => setProjectSearch('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <span className="text-xs text-gray-500 font-medium">
                      {filteredActiveProjects.length} {filteredActiveProjects.length === 1 ? 'project' : 'projects'} available
                    </span>
                  </div>

                  {/* Projects Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredActiveProjects.map((project) => (
                      <div
                        key={project.id}
                        onClick={() => handleOpenProject(project)}
                        className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm hover:border-blue-400 hover:shadow-md transition-all cursor-pointer flex flex-col justify-between group"
                      >
                        <div>
                          {/* Top Header of Card */}
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 group-hover:scale-105 transition-transform">
                              <Folder className="w-5 h-5" />
                            </div>
                            <div className="flex items-center gap-1.5">
                              {renderRoleBadge(project.role)}
                            </div>
                          </div>

                          {/* Project Title & Description */}
                          <h3 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                            {project.name}
                          </h3>
                          <p className="text-sm text-gray-600 line-clamp-2 mt-1.5 min-h-[40px]">
                            {project.description || 'No description provided.'}
                          </p>
                        </div>

                        {/* Stats & Actions Footer */}
                        <div className="pt-4 mt-4 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                          <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1 font-medium text-gray-700">
                              <NotebookPen className="w-3.5 h-3.5 text-gray-400" />
                              {project.meeting_count} calls
                            </span>
                            <span className="flex items-center gap-1">
                              <Users className="w-3.5 h-3.5 text-gray-400" />
                              {project.member_count} members
                            </span>
                          </div>

                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => setMembersModalProject(project)}
                              className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 hover:text-gray-900 transition-colors"
                              title="Manage Members"
                            >
                              <Users className="w-4 h-4" />
                            </button>
                            {(project.role === 'owner' || project.role === 'team_leader') && (
                              <button
                                type="button"
                                onClick={() => setSettingsModalProject(project)}
                                className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 hover:text-gray-900 transition-colors"
                                title="Project Settings"
                              >
                                <SettingsIcon className="w-4 h-4" />
                              </button>
                            )}
                            {(project.role === 'owner' || project.role === 'team_leader') && (
                              <button
                                type="button"
                                onClick={() => handleArchiveProject(project)}
                                className="p-1.5 hover:bg-amber-50 rounded-md text-gray-400 hover:text-amber-700 transition-colors"
                                title="Archive Project"
                              >
                                <Archive className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}

                    {/* Create Project Card */}
                    <div
                      onClick={() => setIsCreateProjectOpen(true)}
                      className="rounded-lg border-2 border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50/20 p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-all min-h-[200px]"
                    >
                      <div className="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 mb-3">
                        <FolderPlus className="w-5 h-5" />
                      </div>
                      <h4 className="text-sm font-semibold text-gray-900">Create New Project</h4>
                      <p className="text-xs text-gray-500 mt-1 max-w-[200px]">
                        Collaborate with teammates or organize separate work streams.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: ARCHIVED PROJECTS */}
              {overviewTab === 'archived' && (
                <div className="space-y-6">
                  {/* Search archived projects bar */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                      <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="Search archived projects..."
                        value={archivedSearch}
                        onChange={(e) => setArchivedSearch(e.target.value)}
                        className="w-full pl-10 pr-10 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-gray-900 placeholder:text-gray-400 shadow-sm transition-all"
                      />
                      {archivedSearch && (
                        <button
                          onClick={() => setArchivedSearch('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <span className="text-xs text-gray-500 font-medium">
                      {filteredArchivedProjects.length} archived {filteredArchivedProjects.length === 1 ? 'project' : 'projects'}
                    </span>
                  </div>

                  {/* Archived Projects Grid */}
                  {filteredArchivedProjects.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {filteredArchivedProjects.map((project) => (
                        <div
                          key={project.id}
                          onClick={() => handleOpenProject(project)}
                          className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm hover:border-amber-400 hover:shadow-md transition-all cursor-pointer flex flex-col justify-between group"
                        >
                          <div>
                            {/* Top Header of Card */}
                            <div className="flex items-start justify-between gap-2 mb-3">
                              <div className="w-10 h-10 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 group-hover:scale-105 transition-transform">
                                <Archive className="w-5 h-5" />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                                  <Archive className="w-3 h-3 text-amber-600" />
                                  Archived
                                </span>
                                {renderRoleBadge(project.role)}
                              </div>
                            </div>

                            {/* Project Title & Description */}
                            <h3 className="text-lg font-semibold text-gray-900 group-hover:text-amber-700 transition-colors">
                              {project.name}
                            </h3>
                            <p className="text-sm text-gray-600 line-clamp-2 mt-1.5 min-h-[40px]">
                              {project.description || 'No description provided.'}
                            </p>
                          </div>

                          {/* Stats & Actions Footer */}
                          <div className="pt-4 mt-4 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                            <div className="flex items-center gap-3">
                              <span className="flex items-center gap-1 font-medium text-gray-700">
                                <NotebookPen className="w-3.5 h-3.5 text-gray-400" />
                                {project.meeting_count} calls
                              </span>
                              <span className="flex items-center gap-1">
                                <Users className="w-3.5 h-3.5 text-gray-400" />
                                {project.member_count} members
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => handleRestoreProject(project)}
                                className="h-7 px-2.5 rounded-md text-xs font-medium border-amber-200 text-amber-800 hover:bg-amber-100 flex items-center gap-1 transition-colors"
                                title="Restore Project to Active"
                              >
                                <RotateCcw className="w-3.5 h-3.5 text-amber-700" />
                                <span>Restore</span>
                              </Button>
                              {project.role === 'owner' && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteProject(project)}
                                  className="p-1.5 hover:bg-red-50 rounded-md text-gray-400 hover:text-red-600 transition-colors"
                                  title="Permanently Delete Project"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="bg-white rounded-lg border border-gray-200 p-12 text-center shadow-sm">
                      <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 mx-auto mb-3">
                        <Archive className="w-6 h-6" />
                      </div>
                      <h3 className="text-base font-semibold text-gray-900">
                        {archivedSearch ? 'No matching archived projects' : 'No archived projects'}
                      </h3>
                      <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
                        {archivedSearch
                          ? `No archived projects found matching "${archivedSearch}". Try adjusting your search query.`
                          : 'Projects you archive will appear here. You can inspect older meetings or restore projects at any time.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ============================================================== */}
          {/* VIEW 2: INSIDE SPECIFIC PROJECT (selectedProject is active)    */}
          {/* ============================================================== */}
          {selectedProject && (
            <div className="space-y-6">
              {/* Archived Project Banner Notice */}
              {selectedProject.is_archived && (
                <div className="p-4 rounded-xl bg-amber-50/90 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-amber-900 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700 shrink-0">
                      <Archive className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-amber-900">This project is archived</p>
                      <p className="text-xs text-amber-700 mt-0.5">
                        Historical meetings and transcripts are preserved below. Restore this project to resume recording calls.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRestoreProject(selectedProject)}
                    className="border-amber-300 bg-white hover:bg-amber-100 text-amber-900 rounded-lg shrink-0 text-xs font-semibold shadow-xs"
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5 text-amber-700" />
                    Restore Project
                  </Button>
                </div>
              )}

              {/* Search and Filters Card — Aligned with Screenshot */}
              <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-2xs space-y-4">
                {/* Search Row */}
                <div className="relative w-full">
                  <Search className="w-4 h-4 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search meetings by name"
                    value={meetingSearch}
                    onChange={(e) => setMeetingSearch(e.target.value)}
                    className="w-full pl-11 pr-10 py-3 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-gray-900 placeholder:text-gray-400 shadow-2xs transition-all"
                  />
                  {meetingSearch && (
                    <button
                      onClick={() => setMeetingSearch('')}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
                      aria-label="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Filter & Sort Row — As requested: Newest First in the same row as date filters */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  {/* Date Filter Buttons */}
                  <div className="flex flex-wrap items-center gap-2">
                    {DATE_FILTER_OPTIONS.map((filter) => {
                      const Icon = filter.icon;
                      const isActive = dateFilter === filter.id;
                      return (
                        <button
                          key={filter.id}
                          type="button"
                          onClick={() => setDateFilter(filter.id)}
                          className={`px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-all cursor-pointer border ${
                            isActive
                              ? 'bg-gray-900 text-white border-gray-900 shadow-2xs'
                              : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50 hover:border-gray-300'
                          }`}
                        >
                          {Icon && <Icon className="w-3.5 h-3.5" />}
                          <span>{filter.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Sort Order Dropdown — In the SAME ROW */}
                  <div className="relative inline-flex items-center">
                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                      className="appearance-none pl-9 pr-8 py-2 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 rounded-xl text-sm font-medium text-gray-700 shadow-2xs cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    >
                      <option value="newest">Newest first</option>
                      <option value="oldest">Oldest first</option>
                    </select>
                    <ArrowUpDown className="w-3.5 h-3.5 text-gray-500 absolute left-3 pointer-events-none" />
                    <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-2.5 pointer-events-none" />
                  </div>
                </div>

                {/* Custom Date Range Picker (Only shown when 'custom' is active) */}
                {dateFilter === 'custom' && (
                  <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-gray-100 text-xs">
                    <span className="text-gray-500 font-medium">Custom range:</span>
                    <div className="flex items-center gap-2">
                      <label className="text-gray-600">From:</label>
                      <input
                        type="date"
                        value={customDateStart}
                        onChange={(e) => setCustomDateStart(e.target.value)}
                        className="border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-800 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-gray-600">To:</label>
                      <input
                        type="date"
                        value={customDateEnd}
                        onChange={(e) => setCustomDateEnd(e.target.value)}
                        className="border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-800 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    {(customDateStart || customDateEnd) && (
                      <button
                        onClick={() => {
                          setCustomDateStart('');
                          setCustomDateEnd('');
                        }}
                        className="text-gray-400 hover:text-gray-600 underline ml-2"
                      >
                        Reset dates
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Showing X of Y meetings counter */}
              <div className="px-1 min-h-[24px] flex items-center">
                {isProjectMeetingsLoading ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                    <LoaderIcon className="w-3.5 h-3.5 animate-spin text-gray-400" />
                    <span>Loading calls...</span>
                  </span>
                ) : (
                  <span className="text-xs sm:text-sm font-medium text-gray-600">
                    Showing {filteredAndSortedMeetings.length} of {selectedProjectMeetingsCount} meetings
                  </span>
                )}
              </div>

              {/* Meeting Records List */}
              <div className="space-y-3">
                {isProjectMeetingsLoading ? (
                  <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-gray-200 shadow-2xs">
                    <LoaderIcon className="animate-spin size-6 text-gray-400 mb-2.5" />
                    <p className="text-xs text-gray-500 font-medium">Loading project meetings...</p>
                  </div>
                ) : filteredAndSortedMeetings.length > 0 ? (
                  filteredAndSortedMeetings.map((meeting) => (
                    <div
                      key={meeting.id}
                      onClick={() => navigateToMeeting(meeting)}
                      className="bg-white rounded-2xl border border-gray-200 p-4 shadow-2xs hover:border-gray-300 hover:shadow-xs transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-200/80 flex items-center justify-center text-gray-700 shrink-0 group-hover:bg-blue-50 group-hover:text-blue-600 group-hover:border-blue-200 transition-colors">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm sm:text-base font-semibold text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                            {cleanMeetingTitle(meeting.title, meeting.created_at)}
                          </h4>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {formatMeetingDate(meeting.created_at)} · {formatMeetingTime(meeting.created_at)}
                          </p>
                        </div>
                      </div>

                      {/* Card Action Buttons */}
                      <div
                        className="flex items-center gap-2 shrink-0 self-end sm:self-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTitle(cleanMeetingTitle(meeting.title, meeting.created_at));
                            setEditModalState({
                              isOpen: true,
                              meetingId: meeting.id,
                              currentTitle: meeting.title,
                            });
                          }}
                          className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
                          title="Rename meeting"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setDeleteModalState({
                              isOpen: true,
                              meetingId: meeting.id,
                            })
                          }
                          className="p-2 text-gray-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                          title="Delete meeting"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigateToMeeting(meeting)}
                          className="text-gray-800 hover:text-blue-600 hover:bg-blue-50/60 flex items-center gap-1.5 text-sm font-medium px-3 h-9"
                        >
                          <span>Open</span>
                          <ArrowRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center shadow-2xs">
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 mx-auto mb-3">
                      <FileText className="w-6 h-6" />
                    </div>
                    <h3 className="text-base font-semibold text-gray-900">
                      {meetingSearch || dateFilter !== 'all' ? 'No matching meetings' : 'No meetings in this project yet'}
                    </h3>
                    <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
                      {meetingSearch || dateFilter !== 'all'
                        ? 'Try adjusting your search query or clear the filter.'
                        : 'Recordings made while this project is active will be automatically organized here.'}
                    </p>
                    {meetingSearch && (
                      <div className="mt-4 flex items-center justify-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMeetingSearch('')}
                          className="text-xs"
                        >
                          Clear Search
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Project Management Dialogs */}
      <CreateProjectDialog
        isOpen={isCreateProjectOpen}
        onClose={() => setIsCreateProjectOpen(false)}
      />

      <ProjectMembersDialog
        isOpen={!!membersModalProject}
        onClose={() => setMembersModalProject(null)}
        project={membersModalProject}
      />

      <ProjectSettingsDialog
        isOpen={!!settingsModalProject}
        onClose={() => setSettingsModalProject(null)}
        project={settingsModalProject}
      />

      {/* Meeting Title Edit Dialog */}
      <Dialog
        open={editModalState.isOpen}
        onOpenChange={(open) => !open && setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' })}
      >
        <DialogContent className="sm:max-w-md bg-white rounded-xl shadow-xl border border-gray-200 p-6">
          <DialogTitle className="text-lg font-semibold text-gray-900">
            Edit Meeting Title
          </DialogTitle>
          <div className="mt-4">
            <label className="text-xs font-semibold text-gray-700 block mb-1.5">
              Title
            </label>
            <Input
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              placeholder="Meeting Title"
              className="rounded-lg border-gray-200 focus-visible:ring-blue-500"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleEditConfirm();
              }}
            />
          </div>
          <DialogFooter className="mt-6 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' })}
              className="rounded-lg text-xs"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleEditConfirm}
              className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs"
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Meeting Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={deleteModalState.isOpen}
        text="Are you sure you want to delete this meeting? This will permanently delete the transcript and all summaries."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModalState({ isOpen: false, meetingId: null })}
      />

      {/* Project Archive Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!projectToArchive}
        title="Archive Project"
        confirmText="Archive"
        confirmColor="bg-amber-600 hover:bg-amber-700"
        text={`Are you sure you want to archive "${projectToArchive?.name}"? It will be moved to the Archived tab.`}
        onConfirm={async () => {
          if (projectToArchive) {
            await archiveProject(projectToArchive.id, true);
            if (selectedProject?.id === projectToArchive.id) {
              setSelectedProject(null);
            }
            setProjectToArchive(null);
          }
        }}
        onCancel={() => setProjectToArchive(null)}
      />

      {/* Project Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!projectToDelete}
        text={`Are you sure you want to permanently delete "${projectToDelete?.name}"? All associated meetings and transcripts will be permanently removed.`}
        onConfirm={async () => {
          if (projectToDelete) {
            await deleteProject(projectToDelete.id);
            if (selectedProject?.id === projectToDelete.id) {
              setSelectedProject(null);
            }
            setProjectToDelete(null);
          }
        }}
        onCancel={() => setProjectToDelete(null)}
      />
    </div>
  );
}
