import { IconTools } from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";

/**
 * 阶段性占位：这些页面在后续阶段实现（见实施顺序）。
 * 先让导航与路由完整可用，避免点进去白屏。
 */
export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <PageContainer>
      <EmptyState icon={<IconTools />} title={title} description={description} />
    </PageContainer>
  );
}
