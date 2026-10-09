// 更新记录页（普通用户可访问）
//
// 用户想知道「我这个版本有什么、最近改了什么」，所以单独给一个入口，
// 而不是埋在后台里（后台只有管理员能看）。
import { PageContainer } from "@/components/layout/PageContainer.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { ChangelogList, VersionLine } from "@/components/domain/Changelog.tsx";

export default function ChangelogPage() {
  usePageHeader("更新记录", "每个版本更新了什么", <VersionLine />);
  return (
    <PageContainer>
      <ChangelogList />
    </PageContainer>
  );
}
