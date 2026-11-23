import './generate.css'

export function GenerationPlatter({ active, artwork }: { active: boolean; artwork?: string }) {
  return (
    <div className="gen-platter mx-auto w-28 sm:w-36" data-spin={active ? '1' : '0'} aria-hidden>
      <div className="gen-vinyl">
        <div className="gen-label">
          {artwork && <img src={artwork} alt="" className="size-full rounded-full object-cover" />}
        </div>
      </div>
    </div>
  )
}
