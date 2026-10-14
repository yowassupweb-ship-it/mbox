import { Building2 } from "lucide-react";
import { isCompanyHome } from "../../app/workbench/projects/projectFields";
import type { Company, Project } from "../../types";

/**
 * Кому что открыть: доступ к компании целиком (все её проекты, в том числе будущие) или к отдельным проектам.
 * Компании идут блоками со своими проектами, ниже — проекты без компании. Проект компании, к которой доступ уже
 * выдан, отмечен и недоступен для снятия: он открыт через компанию.
 */
export function AccessPicker({ projects, companies, selectedProjects, selectedCompanies, onChange, disabled = false }: {
  projects: Project[];
  companies: Company[];
  selectedProjects: string[];
  selectedCompanies: string[];
  onChange: (next: { projects: string[]; companies: string[] }) => void;
  disabled?: boolean;
}) {
  const live = projects.filter((project) => project.status !== "archived");
  const toggleProject = (id: string) => onChange({ projects: selectedProjects.includes(id) ? selectedProjects.filter((item) => item !== id) : [...selectedProjects, id], companies: selectedCompanies });
  const toggleCompany = (id: string) => onChange({ projects: selectedProjects, companies: selectedCompanies.includes(id) ? selectedCompanies.filter((item) => item !== id) : [...selectedCompanies, id] });
  const groups = [...companies].sort((a, b) => a.name.localeCompare(b.name, "ru")).map((company) => ({ company, projects: live.filter((project) => project.company_id === company.id) }));
  const loose = live.filter((project) => !project.company_id || !companies.some((company) => company.id === project.company_id));

  const chip = (project: Project, viaCompany: boolean) => {
    const checked = viaCompany || selectedProjects.includes(project.id);
    return (
      <label className={`account-project${checked ? " is-selected" : ""}${viaCompany ? " is-via-company" : ""}`} key={project.id} title={viaCompany ? "Открыт через доступ ко всей компании" : undefined}>
        <input type="checkbox" checked={checked} disabled={disabled || viaCompany} onChange={() => toggleProject(project.id)} />
        <span>{isCompanyHome(project) ? "Записи компании" : project.name}</span>
      </label>
    );
  };

  return (
    <div className="access-picker" aria-label="Доступ">
      {groups.map(({ company, projects: owned }) => {
        const whole = selectedCompanies.includes(company.id);
        return (
          <div className={`access-company${whole ? " is-whole" : ""}`} key={company.id}>
            <label className="access-company-head" title="Все проекты компании, включая те, что появятся потом">
              <input type="checkbox" checked={whole} disabled={disabled} onChange={() => toggleCompany(company.id)} />
              <Building2 size={14} aria-hidden="true" />
              <b>{company.name}</b>
              <span>{whole ? "вся компания, включая будущие проекты" : "вся компания"}</span>
            </label>
            {owned.length > 0 && <div className="account-projects">{owned.map((project) => chip(project, whole))}</div>}
          </div>
        );
      })}
      {loose.length > 0 && (
        <div className="access-company is-loose">
          {groups.length > 0 && <div className="access-company-head is-static"><span>Без компании</span></div>}
          <div className="account-projects">{loose.map((project) => chip(project, false))}</div>
        </div>
      )}
    </div>
  );
}
