import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button.tsx";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";

export default function NotFoundPage() {
  return (
    <PageContainer>
      <EmptyState
        title="页面不存在"
        description="链接可能已失效，或者你手动改过地址。"
        action={
          <Button asChild size="sm">
            <Link to="/">回到总览</Link>
          </Button>
        }
      />
    </PageContainer>
  );
}
