import React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

interface LogoProps {
    isCollapsed: boolean;
}

const Logo = React.forwardRef<HTMLButtonElement, LogoProps>(({ isCollapsed }, ref) => {
  const router = useRouter();

  const handleClick = () => {
    router.push('/');
  };

  return (
    <>
      {isCollapsed ? (
        <button
          ref={ref}
          onClick={handleClick}
          className="flex items-center justify-start mb-2 cursor-pointer bg-transparent border-none p-0 hover:opacity-80 transition-opacity"
        >
          <Image src="/logo-collapsed.png" alt="CrestMeet Logo" width={40} height={32} />
        </button>
      ) : (
        <button
          ref={ref}
          onClick={handleClick}
          className="w-full text-lg text-center border rounded-full bg-blue-50 border-white font-semibold text-gray-700 mb-2 block items-center cursor-pointer hover:opacity-80 transition-opacity py-1"
        >
          <span>CrestMeet</span>
        </button>
      )}
    </>
  );
});

Logo.displayName = "Logo";

export default Logo;