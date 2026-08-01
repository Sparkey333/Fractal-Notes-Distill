export interface Note {
  id: string;
  text: string;
  children: Note[];
  collapsed?: boolean;
}
