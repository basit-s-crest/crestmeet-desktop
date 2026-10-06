import React from "react";
import { Info as InfoIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";
import { VisuallyHidden } from "./ui/visually-hidden";
import { About } from "./About";

interface InfoProps {
    isCollapsed: boolean;
    version?: string;
}

const Info = React.forwardRef<HTMLButtonElement, InfoProps>(({ isCollapsed, version = "v0.4.0" }, ref) => {
  return (
    <Dialog aria-describedby={undefined}>
      <DialogTrigger asChild>
        <button 
          ref={ref} 
          className={`cursor-pointer transition-all ${
            isCollapsed 
              ? "flex items-center justify-center p-2.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl" 
              : "w-full px-2.5 py-1.5 flex items-center justify-between text-xs font-medium rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100/90 border border-transparent hover:border-slate-200/50 group"
          }`}
          title="About CrestMeet"
        >
          <div className="flex items-center gap-2">
            <InfoIcon className={`transition-colors ${isCollapsed ? "w-5 h-5 text-slate-500" : "w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600"}`} />
            {!isCollapsed && (
              <span className="text-slate-600 group-hover:text-slate-900 font-medium">About CrestMeet</span>
            )}
          </div>
          {!isCollapsed && (
            <span className="text-[10px] font-mono font-medium text-slate-400 bg-slate-100 group-hover:bg-slate-200/80 group-hover:text-slate-600 px-1.5 py-0.5 rounded-md transition-colors">
              {version}
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent>
        <VisuallyHidden>
          <DialogTitle>About CrestMeet</DialogTitle>
        </VisuallyHidden>
        <About />
      </DialogContent>
    </Dialog>
  );
});

Info.displayName = "About";

export default Info; 