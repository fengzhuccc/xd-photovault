import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export default function Empty({
  icon: Icon,
  title = '暂无内容',
  description,
  action,
  className,
}: EmptyProps) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center text-center p-8', className)}>
      {Icon && (
        <div className="mb-4 p-4 rounded-full bg-zinc-900 border border-zinc-800">
          <Icon size={32} className="text-zinc-500" />
        </div>
      )}
      <h3 className="text-base font-medium text-zinc-300 mb-1">{title}</h3>
      {description && <p className="text-sm text-zinc-500 max-w-sm">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
