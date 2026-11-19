import { Boxes, Database, Layers, PackageCheck } from "lucide-react";

export const WORKSPACE_SECTIONS = {
  model: {
    label: "模型",
    title: "模型定位",
    description: "导入自己的模型，或加载示例体验定位。",
    icon: Boxes,
  },
  assembly: {
    label: "组合",
    title: "模型组合",
    description: "管理模块，并对齐选中的模型。",
    icon: Layers,
  },
  data: {
    label: "数据",
    title: "空间数据",
    description: "导入、检查和合并矢量数据。",
    icon: Database,
  },
  delivery: {
    label: "交付",
    title: "项目交付",
    description: "将场景或数据导出到本机。",
    icon: PackageCheck,
  },
} as const;

export type WorkspaceSection = keyof typeof WORKSPACE_SECTIONS;
const sections = Object.keys(WORKSPACE_SECTIONS) as WorkspaceSection[];

export function WorkspaceDock({
  activeSection,
  onSelect,
}: {
  activeSection: WorkspaceSection | null;
  onSelect: (section: WorkspaceSection) => void;
}) {
  return (
    <div className="gs-dock-shelf">
      <nav aria-label="空间装配工具" className="gs-dock">
        {sections.map((section) => {
          const { icon: Icon, label } = WORKSPACE_SECTIONS[section];
          return (
            <button
              type="button"
              key={section}
              className="gs-dock-button"
              aria-pressed={activeSection === section}
              onClick={() => onSelect(section)}
            >
              <span className="gs-dock-icon">
                <Icon aria-hidden="true" size={19} strokeWidth={1.75} />
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
